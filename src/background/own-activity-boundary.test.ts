import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('renews idle only in the trusted surface-activity branch, never for a content fill', () => {
  // Audit the actual worker composition: the inline fill and native popup use
  // different message boundaries even though they share one SessionManager.
  const source = ts.createSourceFile('index.ts', readFileSync(new URL('./index.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText(source) === 'sessionManager'
      && node.expression.name.text === 'touchActivity') calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(calls).toHaveLength(1);
  for (const call of calls) {
    expect(call.arguments.map(argument => argument.getText(source))).toEqual(['raw.observedAt']);
    let parent: ts.Node | undefined = call.parent;
    while (parent && !ts.isIfStatement(parent)) parent = parent.parent;
    expect(parent && ts.isIfStatement(parent) ? parent.expression.getText(source) : null).toBe('isSurfaceActivity(raw)');
  }
});
