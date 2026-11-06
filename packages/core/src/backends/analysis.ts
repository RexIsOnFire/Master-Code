/** Small shared queries backends run over a program before emitting. */

import type { IrProgram } from '../ir/ir.ts';
import { walkModule } from '../ir/ir.ts';

/** Every builtin op the program calls. Backends use it to decide which runtime helpers to ship. */
export function usedBuiltins(program: IrProgram): Set<string> {
  const ops = new Set<string>();
  for (const m of program.modules) {
    walkModule(m, {
      expr: (e) => {
        if (e.k === 'builtin') ops.add(e.op);
      },
    });
  }
  return ops;
}

/** True when the program awaits anything or declares an async function. */
export function usesAsync(program: IrProgram): boolean {
  let found = false;
  for (const m of program.modules) {
    walkModule(m, {
      expr: (e) => {
        if (e.k === 'await' || (e.k === 'lambda' && e.isAsync)) found = true;
      },
      decl: (d) => {
        if (d.k === 'function' && d.isAsync) found = true;
      },
    });
  }
  return found;
}

/** Named types the program refers to but does not declare. */
export function externalTypeNames(program: IrProgram): Set<string> {
  const declared = new Set<string>();
  for (const m of program.modules) {
    for (const d of m.decls) {
      if (d.k === 'class' || d.k === 'interface' || d.k === 'enum' || d.k === 'typeAlias') declared.add(d.name);
    }
  }
  const used = new Set<string>();
  for (const m of program.modules) {
    walkModule(m, {
      expr: (e) => {
        if (e.type.kind === 'named' && !declared.has(e.type.name)) used.add(e.type.name);
      },
    });
  }
  return used;
}
