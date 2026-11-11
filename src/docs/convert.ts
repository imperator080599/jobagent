// Conversions de documents par LibreOffice (rendu fidèle des fichiers Word) et
// Poppler (aperçus image). Ces outils ne sont présents que dans l'environnement
// « worker » (conteneur) : leur disponibilité est testée, jamais supposée.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConfigError } from '../core/errors.js';

function run(cmd: string, args: string[], opts: { timeoutMs: number; cwd?: string }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: opts.timeoutMs, cwd: opts.cwd, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: String(stderr) }));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

const SOFFICE = process.env.SOFFICE_PATH || 'soffice';
let capabilities: Promise<{ office: boolean; poppler: boolean }> | null = null;

/** Outils de rendu disponibles sur cette machine. */
export function documentCapabilities(): Promise<{ office: boolean; poppler: boolean }> {
  if (!capabilities) {
    capabilities = (async () => {
      const ok = async (cmd: string, args: string[]) => {
        try {
          await run(cmd, args, { timeoutMs: 20_000 });
          return true;
        } catch {
          return false;
        }
      };
      return { office: await ok(SOFFICE, ['--version']), poppler: await ok('pdftoppm', ['-v']) };
    })();
  }
  return capabilities;
}

export function resetCapabilitiesCache() {
  capabilities = null;
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'jobagent-doc-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// LibreOffice ne supporte pas plusieurs conversions simultanées sur un même profil :
// les conversions sont mises en file et chacune utilise un profil isolé.
let chain: Promise<unknown> = Promise.resolve();

async function officeConvert(input: Uint8Array, inputName: string, target: string, filter?: string): Promise<Uint8Array> {
  const caps = await documentCapabilities();
  if (!caps.office) throw new ConfigError("LibreOffice n'est pas disponible sur cette machine : le rendu des documents est effectué par le worker (conteneur).", 'office_missing');
  const job = chain.then(() =>
    withTempDir(async (dir) => {
      const inPath = path.join(dir, inputName);
      await writeFile(inPath, input);
      const profile = `file://${path.join(dir, 'profile')}`;
      await run(SOFFICE, [`-env:UserInstallation=${profile}`, '--headless', '--norestore', '--nolockcheck', '--convert-to', filter ? `${target}:${filter}` : target, '--outdir', dir, inPath], { timeoutMs: 120_000, cwd: dir });
      const outName = `${path.parse(inputName).name}.${target}`;
      const produced = (await readdir(dir)).find((f) => f === outName);
      if (!produced) throw new Error(`La conversion en ${target.toUpperCase()} n'a produit aucun fichier.`);
      return new Uint8Array(await readFile(path.join(dir, produced)));
    }),
  );
  chain = job.catch(() => undefined);
  return job;
}

export function docxToPdf(docx: Uint8Array): Promise<Uint8Array> {
  return officeConvert(docx, 'document.docx', 'pdf', 'writer_pdf_Export');
}

/** Convertit un modèle RTF, DOC ou ODT en DOCX (format de travail unique des templates). */
export function toDocx(data: Uint8Array, extension: 'rtf' | 'doc' | 'odt'): Promise<Uint8Array> {
  return officeConvert(data, `document.${extension}`, 'docx', 'MS Word 2007 XML');
}

/** Images PNG des pages d'un PDF (aperçus et contrôle visuel). */
export async function pdfToPng(pdf: Uint8Array, opts: { dpi?: number; maxPages?: number } = {}): Promise<Uint8Array[]> {
  const caps = await documentCapabilities();
  if (!caps.poppler) throw new ConfigError("Poppler (pdftoppm) n'est pas disponible sur cette machine.", 'poppler_missing');
  return withTempDir(async (dir) => {
    const inPath = path.join(dir, 'in.pdf');
    await writeFile(inPath, pdf);
    await run('pdftoppm', ['-png', '-r', String(opts.dpi ?? 80), '-f', '1', '-l', String(opts.maxPages ?? 3), inPath, path.join(dir, 'page')], { timeoutMs: 60_000 });
    const files = (await readdir(dir)).filter((f) => f.startsWith('page') && f.endsWith('.png')).sort();
    return Promise.all(files.map(async (f) => new Uint8Array(await readFile(path.join(dir, f)))));
  });
}

/** Polices réellement incorporées dans un PDF (nom de base, sans préfixe de sous-ensemble). */
export async function pdfFonts(pdf: Uint8Array): Promise<string[]> {
  const caps = await documentCapabilities();
  if (!caps.poppler) return [];
  return withTempDir(async (dir) => {
    const inPath = path.join(dir, 'in.pdf');
    await writeFile(inPath, pdf);
    const { stdout } = await run('pdffonts', [inPath], { timeoutMs: 30_000 });
    return [...new Set(stdout.split('\n').slice(2).map((l) => l.trim().split(/\s+/)[0] ?? '').filter(Boolean).map((n) => n.replace(/^[A-Z]{6}\+/, '')))];
  });
}
