/** Physical keyboard shortcuts work with Russian, English and other layouts.
 * Use KeyboardEvent.code for Latin letter positions; preserve event.key for
 * semantic keys (arrows, Escape, Delete) and unusual/virtual keyboards.
 */
export function shortcutKey(event:Pick<KeyboardEvent,'code'|'key'>):string {
  const code=event.code;
  if(/^Key[A-Z]$/.test(code))return code.slice(3).toLowerCase();
  if(code==='Space')return ' ';
  if(code==='Equal'||code==='NumpadAdd')return '+';
  if(code==='Minus'||code==='NumpadSubtract')return '-';
  if(code==='Digit0'||code==='Numpad0')return '0';
  return event.key.toLowerCase();
}
