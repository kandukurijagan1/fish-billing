const fs = require('fs');
const code = fs.readFileSync('Code.gs', 'utf8');
let depth = 0;
let line = 1;
let i = 0;
let stack = [];
while (i < code.length) {
  if (code[i] === '\n') line++;
  if (code.slice(i, i+2) === '//') {
    while (i < code.length && code[i] !== '\n') i++;
    continue;
  }
  if (code.slice(i, i+2) === '/*') {
    while (i < code.length && code.slice(i, i+2) !== '*/') {
      if (code[i] === '\n') line++;
      i++;
    }
    i += 2;
    continue;
  }
  if (code[i] === '\'' || code[i] === '\"' || code[i] === '`') {
    const q = code[i];
    i++;
    while (i < code.length) {
      if (code[i] === '\n') line++;
      if (code[i] === '\\') { i += 2; continue; }
      if (code[i] === q) break;
      i++;
    }
  }
  if (code[i] === '{') {
    depth++;
    stack.push(line);
  } else if (code[i] === '}') {
    depth--;
    stack.pop();
  }
  i++;
}
console.log('Unclosed braces at lines:', stack);
