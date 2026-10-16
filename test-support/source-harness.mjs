// Evaluate a selected production function with explicit dependency doubles.
// AST selection tolerates formatting and signatures; assertions exercise behavior.
import ts from 'typescript'
import { readFileSync } from 'node:fs'

export function sourceFunction(path, name, bindings = {}) {
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
    let match
    function visit(node) {
        if (ts.isFunctionDeclaration(node) && node.name?.text === name) match = node
        else if (ts.isPropertyAssignment(node) && node.name.getText(source) === name) match = node.initializer
        else if (name.startsWith('if:') && ts.isIfStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(source) === name.slice(3)) match = node
        ts.forEachChild(node, visit)
    }
    visit(source)
    if (!match) throw new Error(`Missing production function ${name} in ${path}`)
    let expression = match.getText(source).replace(/^export\s+/, '')
    if (name.startsWith('if:')) expression = `() => { ${expression} }`
    if (bindings.__import) expression = expression.replace(/\bimport\s*\(/g, '__import(')
    if (bindings.__env) expression = expression.replace(/\bimport\.meta\.env\b/g, '__env')
    const js = ts.transpileModule(`const selected = ${expression};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    return new Function(...Object.keys(bindings), `${js}; return selected`)(...Object.values(bindings))
}
