/* Minimal syntax highlighter (regex tokeniser) for the languages in this repo. */
(function (CS) {
  'use strict';
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const words = (list) => new RegExp(`\\b(?:${list.split(' ').join('|')})\\b`);

  const STR_D = /"(?:\\.|[^"\\\n])*"/, STR_S = /'(?:\\.|[^'\\\n])*'/;
  const NUM = /\b(?:0x[0-9a-fA-F]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/;
  const CALL = /\b[A-Za-z_]\w*(?=\s*\()/;

  const LANG = {
    py: [
      [/#.*/, 'c'], [/[rbuf]{0,2}"""[\s\S]*?"""|[rbuf]{0,2}'''[\s\S]*?'''/, 's'], [/[rbuf]{0,2}"(?:\\.|[^"\\\n])*"|[rbuf]{0,2}'(?:\\.|[^'\\\n])*'/, 's'],
      [/@[\w.]+/, 'd'],
      [/(?<=\b(?:def|class)\s+)\w+/, 'f'],
      [words('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'), 'k'],
      [words('True False None self cls print len range int float str dict list set tuple bool type isinstance super open min max abs round sorted enumerate zip any all next iter getattr setattr hasattr Exception RuntimeError OSError'), 'b'],
      [NUM, 'n'], [CALL, 'f'],
    ],
    js: [
      [/\/\/.*|\/\*[\s\S]*?\*\//, 'c'], [/`(?:\\.|[^`\\])*`/, 's'], [STR_D, 's'], [STR_S, 's'],
      [/(?<=\b(?:class|function)\s+)\w+/, 'f'],
      [words('const let var function return if else for while do break continue new class extends super this typeof instanceof in of try catch finally throw switch case default async await yield delete void static get set'), 'k'],
      [words('null undefined true false NaN Infinity Math JSON Object Array Date Number String Set Map Promise window document console'), 'b'],
      [NUM, 'n'], [CALL, 'f'],
    ],
    json: [[/"(?:\\.|[^"\\])*"(?=\s*:)/, 'p'], [STR_D, 's'], [/\b(?:true|false|null)\b/, 'k'], [/-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/, 'n']],
    yaml: [[/#.*/, 'c'], [/^[ \t-]*[\w.$-]+(?=\s*:)/, 'p'], [STR_D, 's'], [STR_S, 's'], [/\b(?:true|false|null|yes|no)\b/, 'k'], [NUM, 'n']],
    sql: [
      [/--.*/, 'c'], [STR_S, 's'],
      [/\b(?:SELECT|FROM|WHERE|INTO|AS|WITH|UNION|CROSS|APPLY|GROUP|BY|HAVING|ORDER|CASE|WHEN|THEN|ELSE|END|AND|OR|NOT|BETWEEN|IN|IS|NULL|TIMESTAMP|ON|JOIN|LIMIT)\b/i, 'k'],
      [/\b(?:CAST|SUM|AVG|MIN|MAX|COUNT|CONCAT|DATEDIFF|GetArrayElements|TumblingWindow|SlidingWindow|HoppingWindow|System\.Timestamp)\b/, 'f'],
      [NUM, 'n'],
    ],
    sh: [
      [/#.*/, 'c'], [STR_D, 's'], [STR_S, 's'], [/\$\{[^}]+\}|\$\w+|\$\(/, 'p'],
      [words('if then else fi for do done while case esac function in echo export set local return exit sudo'), 'k'],
      [/(?<=^|\s)--?[\w-]+/, 'b'], [/\b(?:az|func|apt-get|pip|python3|systemctl|raspi-config|useradd|grep|tee|mkdir|cp|chmod|chown)\b/, 'f'], [NUM, 'n'],
    ],
    css: [[/\/\*[\s\S]*?\*\//, 'c'], [STR_D, 's'], [/#[0-9a-fA-F]{3,8}\b/, 'n'], [/--[\w-]+/, 'p'], [/[\w-]+(?=\s*:[^:])/, 'f'], [/@[\w-]+/, 'k'], [/\b\d+(?:\.\d+)?(?:px|%|s|ms|em|vh|fr|deg)?\b/, 'n']],
    html: [[/<!--[\s\S]*?-->/, 'c'], [STR_D, 's'], [/<\/?[\w-]+|\/?>/, 'k'], [/\b[\w-]+(?==)/, 'p']],
    ini: [[/#.*|;.*/, 'c'], [/^\[.*\]$/, 'k'], [/^[\w.-]+(?==)/, 'p'], [STR_D, 's']],
    md: [[/^#{1,6} .*/, 'k'], [/`[^`\n]+`/, 's'], [/\*\*[^*]+\*\*/, 'b'], [/^\s*[-*] /, 'p'], [/\|/, 'c']],
  };
  LANG.asaql = LANG.sql;
  LANG.service = LANG.ini;
  LANG.txt = [];

  const cache = {};
  function compile(lang) {
    if (cache[lang]) return cache[lang];
    const rules = LANG[lang];
    if (!rules || !rules.length) return null;
    const flags = lang === 'sql' || lang === 'asaql' ? 'gmi' : 'gm';
    return (cache[lang] = { re: new RegExp(rules.map((r) => `(${r[0].source})`).join('|'), flags), cls: rules.map((r) => r[1]) });
  }

  function highlight(code, lang) {
    const c = compile(lang);
    if (!c) return esc(code);
    let out = '', last = 0, m;
    c.re.lastIndex = 0;
    while ((m = c.re.exec(code))) {
      if (m[0] === '') { c.re.lastIndex++; continue; }
      out += esc(code.slice(last, m.index));
      let gi = 1;
      while (m[gi] === undefined) gi++;
      out += `<span class="tok-${c.cls[gi - 1]}">${esc(m[0])}</span>`;
      last = m.index + m[0].length;
    }
    return out + esc(code.slice(last));
  }

  function langOf(path) {
    const ext = path.split('.').pop().toLowerCase();
    return { py: 'py', js: 'js', json: 'json', yaml: 'yaml', yml: 'yaml', asaql: 'asaql', sql: 'sql', sh: 'sh', css: 'css', html: 'html', service: 'service', md: 'md', txt: 'txt' }[ext] || 'txt';
  }

  CS.highlight = highlight;
  CS.highlight.langOf = langOf;
})(window.CS = window.CS || {});
