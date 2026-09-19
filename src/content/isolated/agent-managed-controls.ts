const managed = new WeakSet<Element>();

export function markAgentManagedControl(element: Element): void { managed.add(element); }
export function unmarkAgentManagedControl(element: Element): void { managed.delete(element); }
export function isAgentManagedControl(element: Element): boolean { return managed.has(element); }

export function formContainsAgentManagedControl(form: HTMLFormElement): boolean {
  return [...form.elements].some((element) => managed.has(element));
}
