#!/usr/bin/env bash
# Provision the ColdChain Sentinel Azure resources with the Azure CLI.
# Works on an Azure for Students subscription. Run in Cloud Shell or after `az login`.
#   az extension add --name azure-iot
set -euo pipefail

RG=rg-coldchain
LOC=centralindia
HUB=coldchain-iothub-$RANDOM          # must be globally unique
SB=coldchain-sb-$RANDOM
COSMOS=coldchain-cosmos-$RANDOM
SIGNALR=coldchain-signalr-$RANDOM
FUNC=coldchain-func-$RANDOM
STORAGE=coldchainst$RANDOM
EDGE=coldstore-pi-01
BASELINE=baseline-node-02

az group create -n $RG -l $LOC

# --- IoT Hub (S1: 400k msgs/day; F1 free tier allows 8k/day — enough at 15 s sampling) ---
az iot hub create -g $RG -n $HUB --sku S1 --partition-count 2 -l $LOC
az iot hub consumer-group create --hub-name $HUB -n telemetry-fn
az iot hub consumer-group create --hub-name $HUB -n asa

# --- device identities (symmetric-key / SAS auth) ---
az iot hub device-identity create --hub-name $HUB -d $EDGE
az iot hub device-identity create --hub-name $HUB -d $BASELINE
az iot hub device-twin update --hub-name $HUB -d $EDGE --desired '{
  "profile": "pharma",
  "thresholds": {"temp_min_c": 2.0, "temp_max_c": 8.0, "rh_min_pct": 35, "rh_max_pct": 75, "alarm_delay_samples": 2},
  "sampleIntervalSec": 5 }'
az iot hub device-twin update --hub-name $HUB -d $EDGE --tags '{"site":"warehouse-a","room":"cold-room-1"}'

# --- Service Bus queue for alerts ---
az servicebus namespace create -g $RG -n $SB -l $LOC --sku Standard
az servicebus queue create -g $RG --namespace-name $SB -n cold-alerts --default-message-time-to-live P7D
SB_CONN=$(az servicebus namespace authorization-rule keys list -g $RG --namespace-name $SB \
          -n RootManageSharedAccessKey --query primaryConnectionString -o tsv)

# --- IoT Hub message routing ---
#   alerts-route    : alert = 'true'      → Service Bus queue  (AlertProcessor function)
#   telemetry-route : true                → built-in events    (TelemetryIngest function + Stream Analytics)
az iot hub message-endpoint create servicebus-queue --hub-name $HUB -g $RG \
   --en sb-alerts --erg $RG -c "$SB_CONN;EntityPath=cold-alerts"
az iot hub message-route create --hub-name $HUB -g $RG --rn alerts-route \
   --source DeviceMessages --en sb-alerts --condition "alert = 'true'" --enabled true
az iot hub message-route create --hub-name $HUB -g $RG --rn telemetry-route \
   --source DeviceMessages --en events --condition "alert = 'false'" --enabled true
az iot hub message-route create --hub-name $HUB -g $RG --rn twin-route \
   --source TwinChangeEvents --en events --condition "true" --enabled true

# --- Cosmos DB (serverless) ---
az cosmosdb create -g $RG -n $COSMOS --capabilities EnableServerless --locations regionName=$LOC
az cosmosdb sql database create -g $RG -a $COSMOS -n coldchain
for c in telemetry alerts aggregates; do
  az cosmosdb sql container create -g $RG -a $COSMOS -d coldchain -n $c -p /deviceId --ttl 7776000   # 90 days
done

# --- SignalR (serverless) for the live dashboard ---
az signalr create -g $RG -n $SIGNALR --sku Free_F1 --service-mode Serverless -l $LOC

# --- Function App (Python, consumption plan) ---
az storage account create -g $RG -n $STORAGE -l $LOC --sku Standard_LRS
az functionapp create -g $RG -n $FUNC --storage-account $STORAGE --consumption-plan-location $LOC \
   --runtime python --runtime-version 3.11 --functions-version 4 --os-type Linux
az functionapp config appsettings set -g $RG -n $FUNC --settings \
   "IOTHUB_EVENTHUB_NAME=$(az iot hub show -n $HUB --query properties.eventHubEndpoints.events.path -o tsv)" \
   "IoTHubEventHubConnection=$(az iot hub connection-string show -n $HUB --default-eventhub --query connectionString -o tsv)" \
   "ServiceBusConnection=$SB_CONN" \
   "CosmosDbConnection=$(az cosmosdb keys list -g $RG -n $COSMOS --type connection-strings --query 'connectionStrings[0].connectionString' -o tsv)" \
   "AzureSignalRConnectionString=$(az signalr key list -g $RG -n $SIGNALR --query primaryConnectionString -o tsv)"
( cd ../functions && func azure functionapp publish $FUNC --python )

# --- Event Grid: device connected / disconnected → ConnectionMonitor ---
az eventgrid event-subscription create -n device-connection \
   --source-resource-id "$(az iot hub show -n $HUB --query id -o tsv)" \
   --endpoint-type azurefunction \
   --endpoint "$(az functionapp show -g $RG -n $FUNC --query id -o tsv)/functions/ConnectionMonitor" \
   --included-event-types Microsoft.Devices.DeviceConnected Microsoft.Devices.DeviceDisconnected

echo
echo "Device connection string for the Raspberry Pi (/etc/coldstore/iothub.env):"
az iot hub device-identity connection-string show --hub-name $HUB -d $EDGE -o tsv
echo
echo "Watch messages arrive:   az iot hub monitor-events -n $HUB -d $EDGE --properties all"
echo "Invoke a direct method:  az iot hub invoke-device-method -n $HUB -d $EDGE --method-name getDiagnostics"
