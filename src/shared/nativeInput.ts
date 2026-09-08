export function setNativeInputValue(
  input: HTMLInputElement | null,
  value: string,
  inputPrototype?: object,
): void {
  if (!input) return;
  // Genuinely unbound on purpose: React tracks its own value on the input
  // node, so the only way to make it observe a programmatic change is to call
  // the prototype's native setter against that node. It is invoked with
  // .call(input, …) below, never as a free function.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const setter = Object.getOwnPropertyDescriptor(
    inputPrototype ?? window.HTMLInputElement.prototype,
    'value',
  )?.set;
  setter ? setter.call(input, value) : (input.value = value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
