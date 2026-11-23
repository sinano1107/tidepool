import { relative } from "node:path";
import ts from "typescript";

/**
 * ADR 0404 決定5 の検出器。(a) Promise を返す関数の、Date か Date の欄を持つ object に解決される引数(`file fn(param)` /
 * `file fn(param.member)`)と、(b) 現在時刻の読みから作った値が async 関数の await の後に参照されること(`file fn: name`)を返す。
 * permanent に名がある引数・欄・値は返さず、当たった名を exempted に返す。
 */
export function findCurrentTimeDates(program: ts.Program, root: string, permanent: ReadonlySet<string>) {
  const checker = program.getTypeChecker();
  const named = (type: ts.Type, name: string): boolean =>
    type.isUnion() ? type.types.some((t) => named(t, name)) : type.getSymbol()?.getName() === name;
  const reports: string[] = [];
  const exempted = new Set<string>();
  const report = (site: string, name: string) => (permanent.has(name) ? exempted.add(name) : reports.push(site));
  // 現在時刻の読み = 戻りの型が Date の呼び出し(clock.now()、() => Date)と、その getTime() / toISOString()。Date.now() は数で、締切の読み
  const isTimeRead = (expression: ts.Expression): boolean =>
    ts.isCallExpression(expression) &&
    (named(checker.getTypeAtLocation(expression), "Date") ||
      (ts.isPropertyAccessExpression(expression.expression) &&
        ["getTime", "toISOString"].includes(expression.expression.name.text) &&
        isTimeRead(expression.expression.expression)));
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile || program.isSourceFileFromExternalLibrary(sourceFile)) continue;
    const file = relative(root, sourceFile.fileName);
    const visit = (node: ts.Node) => {
      if (isFunction(node) && node.body) {
        const signature = checker.getSignatureFromDeclaration(node);
        if (signature && named(checker.getReturnTypeOfSignature(signature), "Promise")) {
          for (const parameter of node.parameters) {
            const type = checker.getTypeAtLocation(parameter);
            const name = parameter.name.getText();
            const site = `${file} ${nameOf(node)}(${name}`;
            if (named(type, "Date")) {
              report(`${site})`, name);
              continue;
            }
            for (const member of type.isUnion() ? type.types : [type]) {
              for (const property of checker.getPropertiesOfType(member)) {
                if (named(checker.getTypeOfSymbolAtLocation(property, parameter), "Date")) report(`${site}.${property.getName()})`, property.getName());
              }
            }
          }
        }
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isTimeRead(node.initializer)) {
        const variable = checker.getSymbolAtLocation(node.name);
        const maker = ts.findAncestor(node.parent, isFunction);
        // 参照から作った関数まで、間の関数を1段ずつ上る。どの段でも、その段の await の後なら遅れた参照
        const late = (reference: ts.Node) => {
          let at: ts.Node = reference;
          for (let fn = ts.findAncestor(reference.parent, isFunction); fn; at = fn, fn = ts.findAncestor(fn.parent, isFunction)) {
            if (isAsync(fn) && awaitsBetween(fn, fn === maker ? node.end : 0, at.pos)) return true;
            if (fn === maker) return false;
          }
          return false;
        };
        // `{ now }` の now は property の symbol に解決されるので、値の側の symbol で比べる
        const refers = (id: ts.Identifier) =>
          (ts.isShorthandPropertyAssignment(id.parent) ? checker.getShorthandAssignmentValueSymbol(id.parent) : checker.getSymbolAtLocation(id)) ===
          variable;
        if (references(sourceFile, (id) => id !== node.name && refers(id)).some(late)) {
          report(`${file} ${nameOf(node.parent)}: ${node.name.text}`, node.name.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return { reports, exempted: [...exempted] };
}

function isFunction(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

// 無名の関数は、名前を持つ最も近い祖先(代入先の変数・property、包む関数)の名で呼ぶ
function nameOf(node: ts.Node): string {
  for (let at: ts.Node | undefined = node; at; at = at.parent) {
    if ((isFunction(at) || ts.isVariableDeclaration(at) || ts.isPropertyAssignment(at) || ts.isPropertyDeclaration(at)) && at.name) {
      return at.name.getText();
    }
  }
  return "<module>";
}

function isAsync(node: ts.FunctionLikeDeclaration): boolean {
  return (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Async) !== 0;
}

/** fn 自身の本体(入れ子の関数を除く)に、from と to の間で終わる await があるか */
// shortcut: 文面の順で比べるので、loop の中で await より前に書いた参照(2周目には await の後)を拾わない。その形で欠陥が出たら loop を見る
function awaitsBetween(fn: ts.FunctionLikeDeclaration, from: number, to: number): boolean {
  const found = (node: ts.Node): boolean => {
    if (isFunction(node)) return false;
    const awaits = ts.isAwaitExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier !== undefined);
    return (awaits && node.pos >= from && node.end <= to) || (ts.forEachChild(node, found) ?? false);
  };
  return fn.body !== undefined && found(fn.body);
}

function references(sourceFile: ts.SourceFile, matches: (id: ts.Identifier) => boolean): ts.Identifier[] {
  const found: ts.Identifier[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && matches(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}
