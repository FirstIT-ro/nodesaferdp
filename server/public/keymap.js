'use strict';
// KeyboardEvent.code -> [Windows virtual-key code, extended-key flag].
// Using physical key codes means the remote machine's keyboard layout decides
// which character is produced, just like Microsoft RDP does.
const KEYMAP = (() => {
  const m = {};
  for (let i = 0; i < 26; i++) m['Key' + String.fromCharCode(65 + i)] = [65 + i, false];
  for (let i = 0; i < 10; i++) { m['Digit' + i] = [48 + i, false]; m['Numpad' + i] = [96 + i, false]; }
  for (let i = 1; i <= 24; i++) m['F' + i] = [0x6F + i, false];
  Object.assign(m, {
    Escape: [0x1B, false], Backspace: [0x08, false], Tab: [0x09, false], Enter: [0x0D, false], Space: [0x20, false],
    ShiftLeft: [0xA0, false], ShiftRight: [0xA1, false], ControlLeft: [0xA2, false], ControlRight: [0xA3, true],
    AltLeft: [0xA4, false], AltRight: [0xA5, true], MetaLeft: [0x5B, true], MetaRight: [0x5C, true], OSLeft: [0x5B, true], OSRight: [0x5C, true],
    ContextMenu: [0x5D, true], CapsLock: [0x14, false], NumLock: [0x90, false], ScrollLock: [0x91, false],
    Pause: [0x13, false], PrintScreen: [0x2C, true],
    Insert: [0x2D, true], Delete: [0x2E, true], Home: [0x24, true], End: [0x23, true], PageUp: [0x21, true], PageDown: [0x22, true],
    ArrowLeft: [0x25, true], ArrowUp: [0x26, true], ArrowRight: [0x27, true], ArrowDown: [0x28, true],
    NumpadMultiply: [0x6A, false], NumpadAdd: [0x6B, false], NumpadSubtract: [0x6D, false], NumpadDecimal: [0x6E, false],
    NumpadDivide: [0x6F, true], NumpadEnter: [0x0D, true],
    Minus: [0xBD, false], Equal: [0xBB, false], BracketLeft: [0xDB, false], BracketRight: [0xDD, false], Backslash: [0xDC, false],
    Semicolon: [0xBA, false], Quote: [0xDE, false], Backquote: [0xC0, false], Comma: [0xBC, false], Period: [0xBE, false],
    Slash: [0xBF, false], IntlBackslash: [0xE2, false], IntlRo: [0xC1, false],
  });
  return m;
})();
