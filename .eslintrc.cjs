module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: ['dist', '.eslintrc.cjs'],
  parser: '@typescript-eslint/parser',
  plugins: [],
  rules: {
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none', varsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'warn',
    'no-empty': ['error', { allowEmptyCatch: true }],
    // ui/dialog and ui/dropdown-menu are our own components, not Radix: these props type-check
    // as DOM attributes or spread through, but nothing ever calls them.
    'no-restricted-syntax': ['error', {
      selector: 'JSXOpeningElement[name.name=/^(Dialog|DialogContent|DialogHeader|DialogFooter|DialogTitle|DialogDescription|DropdownMenu|DropdownMenuTrigger|DropdownMenuContent|DropdownMenuItem|DropdownMenuSeparator)$/] > JSXAttribute[name.name=/^(onSelect|onOpenAutoFocus|onCloseAutoFocus|onEscapeKeyDown|onPointerDownOutside|onInteractOutside|onFocusOutside|forceMount|modal|defaultOpen|onValueChange|onCheckedChange)$/]',
      message: 'Radix-only prop on a custom ui primitive: it is never called. Use onClick / onOpenChange, or add real support to the component.',
    }],
  },
}
