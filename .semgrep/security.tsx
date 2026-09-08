function render(input: string, element: HTMLElement) {
  // ruleid: typescript-dynamic-code
  eval(input);
  // ruleid: typescript-dynamic-code
  new Function(input);
  // ruleid: typescript-html-injection
  element.innerHTML = input;
  // ok: typescript-html-injection
  element.textContent = input;
  // ruleid: typescript-html-injection
  return <div dangerouslySetInnerHTML={{ __html: input }} />;
}
