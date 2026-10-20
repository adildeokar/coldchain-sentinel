"""Azure Functions (Python v2 programming model) for ColdChain Sentinel.

  TelemetryIngest   Event Hub trigger on IoT Hub's built-in endpoint (consumer group "telemetry-fn").
                    Expands batches, upserts readings into Cosmos DB with id = deviceId-seq, so a
                    reading re-sent after a lost PUBACK overwrites itself instead of duplicating.
                    Pushes each live reading to the dashboard through SignalR.
  AlertProcessor    Service Bus trigger on queue "cold-alerts" (IoT Hub route: alert = 'true').
                    Stores the alert, computes end-to-end latency, notifies staff, pushes to dashboard.
  ConnectionMonitor Event Grid trigger for Microsoft.Devices.DeviceConnected / DeviceDisconnected.
                    Tells staff the site is offline (and that the edge alarm is covering locally).
  negotiate         HTTP endpoint the dashboard calls to get its SignalR connection info.
"""
import json
import logging
import os
import urllib.request
from datetime import datetime, timezone

import azure.functions as func

app = func.FunctionApp()

DB, HUB = "coldchain", "coldchain"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def _notify(subject: str, body: dict):
    """Hand off to a Logic App (HTTP trigger) that sends e-mail + SMS via Azure Communication Services."""
    url = os.environ.get("NOTIFY_LOGIC_APP_URL")
    if not url:
        logging.warning("NOTIFY_LOGIC_APP_URL not set — notification skipped: %s", subject)
        return
    req = urllib.request.Request(url, data=json.dumps({"subject": subject, **body}).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    urllib.request.urlopen(req, timeout=10).close()


# --------------------------------------------------------------------------------------------
@app.function_name("TelemetryIngest")
@app.event_hub_message_trigger(arg_name="events", event_hub_name="%IOTHUB_EVENTHUB_NAME%",
                               connection="IoTHubEventHubConnection", consumer_group="telemetry-fn",
                               cardinality=func.Cardinality.MANY)
@app.cosmos_db_output(arg_name="docs", connection="CosmosDbConnection", database_name=DB,
                      container_name="telemetry", create_if_not_exists=False)
@app.generic_output_binding(arg_name="signalr", type="signalR", hub_name=HUB,
                            connection="AzureSignalRConnectionString")
def telemetry_ingest(events: list[func.EventHubEvent], docs: func.Out[func.DocumentList],
                     signalr: func.Out[str]):
    out, live = [], []
    received = _now()
    for ev in events:
        body = json.loads(ev.get_body().decode("utf-8"))
        kind, dev = body.get("type"), body.get("deviceId")
        if kind == "telemetry":
            rows = [{"seq": body["seq"], "ts": body["ts"], "tempC": body["tempC"], "rh": body["rh"],
                     "door": body["door"], "status": body["status"]}]
            live.append(body)
        elif kind == "batch":           # backlog synced after an outage — compact keys
            rows = [{"seq": r["q"], "ts": r["ts"], "tempC": r["t"], "rh": r["h"],
                     "door": "open" if r["d"] else "closed", "status": r["s"]} for r in body["readings"]]
        else:
            continue                    # alerts are handled by AlertProcessor
        for r in rows:
            delay_s = (received - _parse(r["ts"])).total_seconds()
            out.append(func.Document.from_dict({
                "id": f"{dev}-{r['seq']}",          # idempotent: duplicates overwrite themselves
                "deviceId": dev, **r,
                "receivedAt": received.isoformat(), "deliveryDelayS": round(delay_s, 1),
                "backfilled": kind == "batch",
            }))
    if out:
        docs.set(func.DocumentList(out))
    signalr.set(json.dumps([{"target": "telemetry", "arguments": [b]} for b in live]))
    logging.info("TelemetryIngest: %d events → %d readings (%d live)", len(events), len(out), len(live))


# --------------------------------------------------------------------------------------------
@app.function_name("AlertProcessor")
@app.service_bus_queue_trigger(arg_name="msg", queue_name="cold-alerts", connection="ServiceBusConnection")
@app.cosmos_db_output(arg_name="alertDoc", connection="CosmosDbConnection", database_name=DB,
                      container_name="alerts", create_if_not_exists=False)
@app.generic_output_binding(arg_name="signalr", type="signalR", hub_name=HUB,
                            connection="AzureSignalRConnectionString")
def alert_processor(msg: func.ServiceBusMessage, alertDoc: func.Out[func.Document], signalr: func.Out[str]):
    a = json.loads(msg.get_body().decode("utf-8"))
    now = _now()
    first = _parse(a["firstBreachAt"])
    latency = {
        "localAlarmS": round((_parse(a["localActionAt"]) - first).total_seconds(), 3),
        "cloudAlertS": round((now - first).total_seconds(), 3),
        "bufferedS": round(a.get("bufferedMs", 0) / 1000, 1),
    }
    doc = {"id": f"{a['deviceId']}-{a['alertId']}-{a['state']}", **a, "processedAt": now.isoformat(),
           "latency": latency, "deliveredLate": a.get("bufferedMs", 0) > 30_000}
    alertDoc.set(func.Document.from_dict(doc))
    signalr.set(json.dumps({"target": "alert", "arguments": [doc]}))

    if a["state"] == "RAISED":
        late = f" (delivered {latency['bufferedS']:.0f} s late — device was offline)" if doc["deliveredLate"] else ""
        _notify(f"[{a['severity'].upper()}] {a['alarm']} at {a['deviceId']}",
                {"text": f"{a['alarm']}: value {a['value']} vs limit {a['threshold']}. "
                         f"Local buzzer active since {a['localActionAt']}{late}.", "alert": doc})
    logging.info("AlertProcessor %s %s cloud latency %.2f s", a["alertId"], a["state"], latency["cloudAlertS"])


# --------------------------------------------------------------------------------------------
@app.function_name("ConnectionMonitor")
@app.event_grid_trigger(arg_name="event")
@app.generic_output_binding(arg_name="signalr", type="signalR", hub_name=HUB,
                            connection="AzureSignalRConnectionString")
def connection_monitor(event: func.EventGridEvent, signalr: func.Out[str]):
    data = event.get_json()
    device = data.get("deviceId")
    state = "online" if event.event_type.endswith("DeviceConnected") else "offline"
    signalr.set(json.dumps({"target": "connection", "arguments": [{"deviceId": device, "state": state,
                                                                    "at": event.event_time.isoformat()}]}))
    if state == "offline":
        _notify(f"[INFO] {device} lost cloud connectivity",
                {"text": "Edge device keeps sampling, alarming locally and buffering readings. "
                         "Data will back-fill automatically when the link returns."})


@app.function_name("negotiate")
@app.route(route="negotiate", auth_level=func.AuthLevel.ANONYMOUS, methods=["POST"])
@app.generic_input_binding(arg_name="connectionInfo", type="signalRConnectionInfo", hub_name=HUB,
                           connection="AzureSignalRConnectionString")
def negotiate(req: func.HttpRequest, connectionInfo) -> func.HttpResponse:
    return func.HttpResponse(connectionInfo, mimetype="application/json")
