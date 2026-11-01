import ts from "typescript"

/** Import regression instrumentation, not a sandbox for arbitrary JavaScript. */
export function moduleSpecifiers(text: string, filename = "module.ts"): string[] {
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true)
  const diagnostics = (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics
  if (diagnostics.length) throw new Error(`Cannot inspect imports in ${filename}: invalid syntax`)
  const found: string[] = []
  const add = (node: ts.Node | undefined) => {
    found.push(node && ts.isStringLiteralLike(node) ? node.text : "#computed-module")
  }
  function visit(node: ts.Node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) add(node.moduleSpecifier)
    if (ts.isImportTypeNode(node)) add(ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined)
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression)
    if (ts.isCallExpression(node)) {
      let target: ts.Expression = node.expression
      while (ts.isParenthesizedExpression(target)) target = target.expression
      const property = ts.isPropertyAccessExpression(target) ? target.name.text
        : ts.isElementAccessExpression(target) && ts.isStringLiteralLike(target.argumentExpression) ? target.argumentExpression.text : undefined
      if (target.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(target) && target.text === "require" || property === "require") add(node.arguments[0])
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}
