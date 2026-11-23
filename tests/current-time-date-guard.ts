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
  // 現在時刻の読み = 戻りの型が Date の呼び出し(clock.now()、() => Date)と、その値(読みから作った局所変数を含む)の
  // getTime() / toISOString()。ADR 0404 決定6: Date.now() は数を返す締切の読みで、対象に含めない
  const isTimeRead = (expression: ts.Expression): boolean =>
    ts.isCallExpression(expression) &&
    (named(checker.getTypeAtLocation(expression), "Date") ||
      (ts.isPropertyAccessExpression(expression.expression) &&
        ["getTime", "toISOString"].includes(expression.expression.name.text) &&
        holdsTimeRead(expression.expression.expression)));
  const holdsTimeRead = (expression: ts.Expression): boolean => {
    if (!ts.isIdentifier(expression)) return isTimeRead(expression);
    const declaration = checker.getSymbolAtLocation(expression)?.valueDeclaration;
    return declaration !== undefined && ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined && isTimeRead(declaration.initializer);
  };
  // (a) Promise を返す関数の、Date か Date の欄を持つ object に解決される引数
  const reportDateParameters = (fn: ts.FunctionLikeDeclaration, file: string) => {
    const signature = checker.getSignatureFromDeclaration(fn);
    if (!signature || !named(checker.getReturnTypeOfSignature(signature), "Promise")) return;
    for (const parameter of fn.parameters) {
      const type = checker.getTypeAtLocation(parameter);
      const name = parameter.name.getText();
      const site = `${file} ${nameOf(fn)}(${name}`;
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
  };
  // (b) 現在時刻の読みから作った値が、async 関数の await の後に参照されること
  const reportLateTimeRead = (variable: ts.VariableDeclaration, name: ts.Identifier, file: string, sourceFile: ts.SourceFile) => {
    const symbol = checker.getSymbolAtLocation(name);
    const maker = ts.findAncestor(variable.parent, isFunction);
    // 参照から作った関数まで、間の関数を1段ずつ上る。どの段でも、その段の await の後なら遅れた参照
    const late = (reference: ts.Node) => {
      for (let fn = ts.findAncestor(reference.parent, isFunction); fn; fn = ts.findAncestor(fn.parent, isFunction)) {
        if (isAsync(fn) && awaitedBefore(fn, fn === maker ? variable.end : 0, reference)) return true;
        if (fn === maker) return false;
      }
      return false;
    };
    // `{ now }` の now は property の symbol に解決されるので、値の側の symbol で比べる
    const refers = (id: ts.Identifier) =>
      (ts.isShorthandPropertyAssignment(id.parent) ? checker.getShorthandAssignmentValueSymbol(id.parent) : checker.getSymbolAtLocation(id)) === symbol;
    if (references(sourceFile, (id) => id !== name && refers(id)).some(late)) {
      report(`${file} ${nameOf(variable.parent)}: ${name.text}`, name.text);
    }
  };
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile || program.isSourceFileFromExternalLibrary(sourceFile)) continue;
    const file = relative(root, sourceFile.fileName);
    const visit = (node: ts.Node) => {
      if (isFunction(node) && node.body) reportDateParameters(node, file);
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isTimeRead(node.initializer)) {
        reportLateTimeRead(node, node.name, file, sourceFile);
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

/** reference が走るまでに、fn 自身の本体(入れ子の関数を除く)の、from より後の await を経たか */
function awaitedBefore(fn: ts.FunctionLikeDeclaration, from: number, reference: ts.Node): boolean {
  // reference を本体に持ち from より後に始まる loop の中の await は、次の周の reference より前に走る
  const loops: ts.IterationStatement[] = [];
  for (let at = reference.parent; at !== fn; at = at.parent) {
    if (ts.isIterationStatement(at, false) && at.pos >= from && reference.pos >= at.statement.pos && reference.end <= at.statement.end) loops.push(at);
  }
  const hasAwait = (node: ts.Node): boolean => {
    if (isFunction(node)) return false;
    const awaits = ts.isAwaitExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier !== undefined);
    const before = node.end <= reference.pos || loops.some((loop) => node.pos >= loop.pos && node.end <= loop.end);
    return (awaits && node.pos >= from && before) || (ts.forEachChild(node, hasAwait) ?? false);
  };
  return fn.body !== undefined && hasAwait(fn.body);
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
