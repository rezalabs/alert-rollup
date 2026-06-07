import neostandard from 'neostandard'
import globals from 'globals'

export default [
    ...neostandard({ noJsx: true }),
    {
        languageOptions: {
            globals: {
                ...globals.node,
                ...globals.jest
            }
        },
        rules: {
            '@stylistic/indent': ['error', 4, {
                SwitchCase: 1,
                VariableDeclarator: 1,
                outerIIFEBody: 1,
                MemberExpression: 1,
                FunctionDeclaration: { parameters: 1, body: 1 },
                FunctionExpression: { parameters: 1, body: 1 },
                CallExpression: { arguments: 1 },
                ArrayExpression: 1,
                ObjectExpression: 1,
                ImportDeclaration: 1,
                flatTernaryExpressions: false,
                ignoreComments: false,
                ignoredNodes: ['TemplateLiteral *'],
                offsetTernaryExpressions: true
            }],
            'no-unused-vars': ['warn']
        }
    },
    {
        ignores: ['node_modules/**', 'coverage/**']
    }
]
