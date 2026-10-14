`tree-sitter-lua.wasm` from [@tree-sitter-grammars/tree-sitter-lua](https://github.com/tree-sitter-grammars/tree-sitter-lua) 0.4.1 (MIT, see LICENSE.md).

Vendored because the Lua grammar in tree-sitter-wasms 0.1.13 returns broken trees on every parse after the first under web-tree-sitter, and the npm package carries a native build step omem does not need.
