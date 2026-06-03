import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && specifier.endsWith('.js')) {
    const parentPath = context.parentURL ? fileURLToPath(context.parentURL) : undefined;
    if (parentPath?.includes(`${process.cwd()}\\src\\`) || parentPath?.includes(`${process.cwd()}/src/`)) {
      const candidate = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
      try {
        await access(fileURLToPath(candidate));
        return { url: candidate.href, shortCircuit: true };
      } catch {
        // Fall through to Node's default resolver.
      }
    }
  }
  return nextResolve(specifier, context);
}
