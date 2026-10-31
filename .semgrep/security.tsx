function render(input: string, element: HTMLElement) {
  // ruleid: typescript-dynamic-code
  eval(input);
  // ruleid: typescript-dynamic-code
  new Function(input);
  // ruleid: typescript-dynamic-code
  Function(input);
  // ruleid: typescript-dynamic-code
  window.eval(input);
  // ruleid: typescript-dynamic-code
  globalThis.eval(input);
  // ruleid: typescript-dynamic-code
  (0, eval)(input);
  // ok: typescript-dynamic-code
  ordinaryFunction(input);
  // ok: typescript-dynamic-code
  window.requestAnimationFrame(ordinaryFunction);
  // ok: typescript-dynamic-code
  globalThis.setTimeout(ordinaryFunction, 0);
  // ruleid: typescript-html-injection
  element.innerHTML = input;
  // ruleid: typescript-html-injection
  element.innerHTML += input;
  // ruleid: typescript-html-injection
  element.outerHTML = input;
  // ruleid: typescript-html-injection
  element.outerHTML += input;
  // ruleid: typescript-html-injection
  element.insertAdjacentHTML('beforeend', input);
  // ruleid: typescript-html-injection
  document.write(input);
  // ruleid: typescript-html-injection
  document.writeln(input);
  // ok: typescript-html-injection
  element.textContent = input;
  // ruleid: typescript-html-injection
  <div dangerouslySetInnerHTML={{ __html: input }} />;
  // ruleid: typescript-html-injection
  <div {...{ dangerouslySetInnerHTML: { __html: input } }} />;
  // ok: typescript-html-injection
  return <div>{input}</div>;
}
