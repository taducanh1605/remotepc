const punctuation = {
  " ": ["Space", false], "\n": ["Enter", false], "\t": ["Tab", false],
  "`": ["Backquote", false], "~": ["Backquote", true], "-": ["Minus", false], "_": ["Minus", true],
  "=": ["Equal", false], "+": ["Equal", true], "[": ["BracketLeft", false], "{": ["BracketLeft", true],
  "]": ["BracketRight", false], "}": ["BracketRight", true], "\\": ["Backslash", false], "|": ["Backslash", true],
  ";": ["Semicolon", false], ":": ["Semicolon", true], "'": ["Quote", false], "\"": ["Quote", true],
  ",": ["Comma", false], "<": ["Comma", true], ".": ["Period", false], ">": ["Period", true],
  "/": ["Slash", false], "?": ["Slash", true],
};

export function typingMessages(text, mode = "host") {
  if (mode === "unicode") return text ? [{ type: "text", text }] : [];
  const messages = [];
  let unicode = "";
  function flush() { if (unicode) { messages.push({ type: "text", text: unicode }); unicode = ""; } }
  for (const character of text) {
    let key = punctuation[character];
    if (/^[a-z]$/i.test(character)) key = [`Key${character.toUpperCase()}`, character === character.toUpperCase()];
    else if (/^[0-9]$/.test(character)) key = [`Digit${character}`, false];
    else if ("!@#$%^&*()".includes(character)) key = [`Digit${"!@#$%^&*()".indexOf(character) === 9 ? 0 : "!@#$%^&*()".indexOf(character) + 1}`, true];
    if (!key) { unicode += character; continue; }
    flush();
    const [code, shift] = key;
    if (shift) messages.push({ type: "key", code: "ShiftLeft", down: true });
    messages.push({ type: "key", code, down: true }, { type: "key", code, down: false });
    if (shift) messages.push({ type: "key", code: "ShiftLeft", down: false });
  }
  flush();
  return messages;
}
