import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = process.cwd();
const source = path.join(
  root,
  'native-plugin/src/main/java/br/com/kej/gestao/updater/KEJUpdaterPlugin.kt'
);
const androidApp = path.join(root, 'android/app');
const destination = path.join(
  androidApp,
  'src/main/java/br/com/kej/gestao/updater/KEJUpdaterPlugin.kt'
);
const javaActivity = path.join(
  androidApp,
  'src/main/java/br/com/kej/gestao/MainActivity.java'
);
const kotlinActivity = path.join(
  androidApp,
  'src/main/java/br/com/kej/gestao/MainActivity.kt'
);
const androidRoot = path.join(root, 'android');
const rootGradle = path.join(androidRoot, 'build.gradle');
const appGradle = path.join(androidApp, 'build.gradle');
const kotlinGradleVersion = '2.1.21';

const packageName = 'br.com.kej.gestao.updater';
const className = 'KEJUpdaterPlugin';

function fail(message) {
  throw new Error(`[KEJ Atualizador] ${message}`);
}

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    fail(`Não foi possível ler: ${file}`);
  }
}

// Mantém exatamente os mesmos offsets UTF-16 do texto original.
// Comentários e strings são mascarados para a análise estrutural.
function maskNonCode(code) {
  const chars = code.split('');
  let i = 0;

  function mask(start, end) {
    for (let j = start; j < end; j++) {
      if (chars[j] !== '\n' && chars[j] !== '\r') chars[j] = ' ';
    }
  }

  while (i < code.length) {
    if (code.startsWith('//', i)) {
      const start = i;
      i += 2;
      while (i < code.length && code[i] !== '\n') i++;
      mask(start, i);
      continue;
    }

    if (code.startsWith('/*', i)) {
      const start = i;
      let depth = 1;
      i += 2;
      while (i < code.length && depth > 0) {
        if (code.startsWith('/*', i)) {
          depth++;
          i += 2;
        } else if (code.startsWith('*/', i)) {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      if (depth !== 0) fail('Comentário de bloco não foi fechado.');
      mask(start, i);
      continue;
    }

    // Kotlin raw strings e Java text blocks.
    if (code.startsWith('"""', i)) {
      const start = i;
      i += 3;
      const end = code.indexOf('"""', i);
      if (end === -1) fail('String multilinha não foi fechada.');
      i = end + 3;
      mask(start, i);
      continue;
    }

    if (code[i] === '"' || code[i] === "'") {
      const start = i;
      const quote = code[i++];
      let closed = false;
      while (i < code.length) {
        if (code[i] === '\\') {
          i += 2;
          continue;
        }
        if (code[i] === quote) {
          i++;
          closed = true;
          break;
        }
        if (code[i] === '\n' || code[i] === '\r') break;
        i++;
      }
      if (!closed) fail('String ou caractere não foi fechado corretamente.');
      mask(start, i);
      continue;
    }

    i++;
  }

  return chars.join('');
}

function findClosingBrace(masked, openingBrace) {
  if (masked[openingBrace] !== '{') fail('Abertura de estrutura não encontrada.');
  let depth = 1;
  for (let i = openingBrace + 1; i < masked.length; i++) {
    if (masked[i] === '{') depth++;
    else if (masked[i] === '}') depth--;
    if (depth === 0) return i;
  }
  fail('Estrutura de código sem fechamento correspondente.');
}

function validatePlugin(code) {
  const masked = maskNonCode(code);
  const escapedPackage = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  if (!new RegExp(`^\\s*package\\s+${escapedPackage}\\s*$`, 'm').test(masked)) {
    fail('Pacote declarado no plugin Kotlin está incorreto.');
  }
  if (!new RegExp(`\\bclass\\s+${className}\\s*:\\s*Plugin\\s*\\(`).test(masked)) {
    fail('Classe KEJUpdaterPlugin não encontrada ou incompatível.');
  }
  if (!/@CapacitorPlugin\s*\(\s*name\s*=\s*"KEJUpdater"\s*\)/.test(code)) {
    fail('Anotação CapacitorPlugin não encontrada.');
  }
  for (const method of ['choosePackage', 'inspectAndStage', 'clearStaging']) {
    if (!new RegExp(`\\bfun\\s+${method}\\s*\\(`).test(masked)) {
      fail(`Método obrigatório ausente: ${method}.`);
    }
  }
}

function locateActivityClass(code, language) {
  const masked = maskNonCode(code);
  const classMatch = /\bclass\s+MainActivity\b/.exec(masked);
  if (!classMatch) fail('Declaração da classe MainActivity não encontrada.');

  const declarationEnd = classMatch.index + classMatch[0].length;
  const openingBrace = masked.indexOf('{', declarationEnd);
  if (openingBrace === -1) fail('Abertura da classe MainActivity não encontrada.');

  const header = masked.slice(classMatch.index, openingBrace);
  const extendsBridge = language === 'java'
    ? /\bextends\s+BridgeActivity\b/.test(header)
    : /:\s*BridgeActivity\s*(?:\(|\b)/.test(header);

  if (!extendsBridge) fail('MainActivity não estende BridgeActivity.');

  const closingBrace = findClosingBrace(masked, openingBrace);
  const lineStart = code.lastIndexOf('\n', classMatch.index) + 1;
  const classIndent = code.slice(lineStart, classMatch.index).match(/^[ \t]*/)?.[0] ?? '';

  return { masked, openingBrace, closingBrace, classIndent };
}

function getLineEnding(code) {
  return code.includes('\r\n') ? '\r\n' : '\n';
}

function addImport(code, statement) {
  const eol = getLineEnding(code);
  const lines = code.split(/\r?\n/);

  if (lines.some(line => line.trim() === statement)) return code;

  const packageIndex = lines.findIndex(line =>
    /^\s*package\s+[\w.]+\s*;?\s*$/.test(line)
  );
  if (packageIndex === -1) fail('Declaração package não encontrada na MainActivity.');

  lines.splice(packageIndex + 1, 0, '', statement);
  return lines.join(eol);
}

function createOnCreate(code, language) {
  const { closingBrace, classIndent } = locateActivityClass(code, language);
  const eol = getLineEnding(code);
  const indent = `${classIndent}    `;
  const methodLines = language === 'java'
    ? [
        `${indent}@Override`,
        `${indent}public void onCreate(Bundle savedInstanceState) {`,
        `${indent}    registerPlugin(KEJUpdaterPlugin.class);`,
        `${indent}    super.onCreate(savedInstanceState);`,
        `${indent}}`
      ]
    : [
        `${indent}override fun onCreate(savedInstanceState: Bundle?) {`,
        `${indent}    registerPlugin(KEJUpdaterPlugin::class.java)`,
        `${indent}    super.onCreate(savedInstanceState)`,
        `${indent}}`
      ];

  // Remove somente a indentação já existente antes da chave final.
  const lineStart = code.lastIndexOf('\n', closingBrace) + 1;
  const closingPrefix = code.slice(lineStart, closingBrace);

  // Classe compacta, por exemplo `public class MainActivity ... {}`:
  // abre espaço antes da chave final em vez de rejeitar a linha como ambígua.
  if (!/^[ \t]*$/.test(closingPrefix)) {
    return (
      code.slice(0, closingBrace) +
      eol + methodLines.join(eol) + eol +
      classIndent +
      code.slice(closingBrace)
    );
  }

  return (
    code.slice(0, lineStart) +
    methodLines.join(eol) + eol +
    closingPrefix +
    code.slice(closingBrace)
  );
}

function insertRegistration(code, language) {
  const { masked, openingBrace, closingBrace } = locateActivityClass(code, language);
  const bodyStart = openingBrace + 1;
  const bodyEnd = closingBrace;
  const classBody = masked.slice(bodyStart, bodyEnd);

  const registrationPattern = language === 'java'
    ? /\bregisterPlugin\s*\(\s*KEJUpdaterPlugin\s*\.\s*class\s*\)\s*;/g
    : /\bregisterPlugin\s*\(\s*KEJUpdaterPlugin\s*::\s*class\s*\.\s*java\s*\)/g;

  const registrations = [...classBody.matchAll(registrationPattern)];

  const methodPattern = language === 'java'
    ? /\bonCreate\s*\(\s*Bundle\s+\w+\s*\)\s*\{/g
    : /\bonCreate\s*\(\s*\w+\s*:\s*Bundle\?\s*\)\s*\{/g;
  const methods = [...classBody.matchAll(methodPattern)];

  if (methods.length > 1) fail('Mais de um onCreate foi encontrado; revisão manual necessária.');

  if (registrations.length > 1) {
    fail('Mais de um registro do KEJUpdater foi encontrado.');
  }

  if (methods.length === 0) {
    if (/\bonCreate\s*\(/.test(classBody)) {
      fail('Formato de onCreate não reconhecido. Revisão manual necessária.');
    }
    if (registrations.length) {
      fail('Registro existente fora de onCreate; revisão manual necessária.');
    }
    if (/\bKEJUpdaterPlugin\b/.test(classBody)) {
      fail('Referência existente ao plugin exige revisão manual.');
    }
    return createOnCreate(code, language);
  }

  const methodMatch = methods[0];
  const methodOpening = bodyStart + methodMatch.index + methodMatch[0].lastIndexOf('{');
  const methodClosing = findClosingBrace(masked, methodOpening);
  const methodBody = masked.slice(methodOpening + 1, methodClosing);

  const superPattern = language === 'java'
    ? /\bsuper\s*\.\s*onCreate\s*\(\s*\w+\s*\)\s*;/
    : /\bsuper\s*\.\s*onCreate\s*\(\s*\w+\s*\)/;
  const superMatch = superPattern.exec(methodBody);
  if (!superMatch) fail('Chamada super.onCreate não encontrada em onCreate.');

  const absoluteSuper = methodOpening + 1 + superMatch.index;
  const registration = registrations[0];

  if (registration) {
    const absoluteRegistration = bodyStart + registration.index;
    if (
      absoluteRegistration <= methodOpening ||
      absoluteRegistration >= methodClosing
    ) {
      fail('Registro do plugin encontrado fora do método onCreate.');
    }
    if (absoluteRegistration > absoluteSuper) {
      fail('Registro do plugin está depois de super.onCreate.');
    }
    return code;
  }

  if (/\bKEJUpdaterPlugin\b/.test(classBody)) {
    fail('Referência existente ao plugin exige revisão manual.');
  }

  const registrationText = language === 'java'
    ? 'registerPlugin(KEJUpdaterPlugin.class);'
    : 'registerPlugin(KEJUpdaterPlugin::class.java)';
  const eol = getLineEnding(code);
  const lineStart = code.lastIndexOf('\n', absoluteSuper) + 1;
  const prefix = code.slice(lineStart, absoluteSuper);
  const methodLineStart = code.lastIndexOf('\n', methodOpening) + 1;
  const methodIndent = code.slice(methodLineStart, methodOpening).match(/^[ \t]*/)?.[0] ?? '    ';
  const indent = `${methodIndent}    `;

  if (/^[ \t]*$/.test(prefix)) {
    return (
      code.slice(0, lineStart) +
      indent + registrationText + eol +
      prefix +
      code.slice(absoluteSuper)
    );
  }

  // onCreate/super na mesma linha: separa as instruções sem perder o código.
  return (
    code.slice(0, absoluteSuper) +
    eol + indent + registrationText +
    eol + indent +
    code.slice(absoluteSuper)
  );
}

function prepareActivity(code, language) {
  code = insertRegistration(code, language);
  code = addImport(
    code,
    language === 'java' ? 'import android.os.Bundle;' : 'import android.os.Bundle'
  );
  code = addImport(
    code,
    language === 'java'
      ? 'import br.com.kej.gestao.updater.KEJUpdaterPlugin;'
      : 'import br.com.kej.gestao.updater.KEJUpdaterPlugin'
  );
  return code;
}

function commitFiles(files) {
  const suffix = `.kej-${process.pid}-${crypto.randomUUID()}`;
  const prepared = files.map(file => ({
    ...file,
    temporary: `${file.path}${suffix}.tmp`,
    backup: `${file.path}${suffix}.bak`,
    hadOriginal: fs.existsSync(file.path),
    backupCreated: false,
    installed: false
  }));

  try {
    for (const file of prepared) {
      fs.mkdirSync(path.dirname(file.path), { recursive: true });
      fs.writeFileSync(file.temporary, file.content, { encoding: 'utf8', flag: 'wx' });
    }

    for (const file of prepared) {
      if (file.hadOriginal) {
        fs.renameSync(file.path, file.backup);
        file.backupCreated = true;
      }
    }

    for (const file of prepared) {
      fs.renameSync(file.temporary, file.path);
      file.installed = true;
    }
  } catch (error) {
    const rollbackErrors = [];

    for (const file of [...prepared].reverse()) {
      try {
        if (file.installed && fs.existsSync(file.path)) fs.unlinkSync(file.path);
        if (file.backupCreated && fs.existsSync(file.backup)) {
          fs.renameSync(file.backup, file.path);
        }
      } catch (rollbackError) {
        rollbackErrors.push(`${file.path}: ${rollbackError.message}`);
      }
    }

    for (const file of prepared) {
      try {
        if (fs.existsSync(file.temporary)) fs.unlinkSync(file.temporary);
      } catch {}
    }

    if (rollbackErrors.length) {
      fail(`Falha na gravação e no rollback. ${rollbackErrors.join(' | ')}`);
    }
    throw error;
  }

  // A limpeza dos backups não desfaz uma instalação já concluída.
  for (const file of prepared) {
    if (file.backupCreated) {
      try {
        fs.unlinkSync(file.backup);
      } catch {
        console.warn(`[KEJ Atualizador] Backup preservado: ${file.backup}`);
      }
    }
  }
}

function prepareKotlinGradle(rootCode, appCode) {
  const rootBuildscript = /\bbuildscript\s*\{/.exec(rootCode);
  if (!rootBuildscript) fail('Bloco buildscript não encontrado em android/build.gradle.');
  const dependenciesPattern = /\bdependencies\s*\{/g;
  dependenciesPattern.lastIndex = rootBuildscript.index + rootBuildscript[0].length;
  const dependenciesMatch = dependenciesPattern.exec(rootCode);
  if (!dependenciesMatch) fail('Bloco dependencies do buildscript não encontrado em android/build.gradle.');

  const kotlinClasspath = `classpath 'org.jetbrains.kotlin:kotlin-gradle-plugin:${kotlinGradleVersion}'`;
  const hasKotlinClasspath = /org\.jetbrains\.kotlin:kotlin-gradle-plugin/.test(rootCode);
  let nextRoot = rootCode;
  if (!hasKotlinClasspath) {
    const insertion = dependenciesMatch.index + dependenciesMatch[0].length;
    const lineStart = rootCode.lastIndexOf('\n', insertion) + 1;
    const indent = (rootCode.slice(lineStart, insertion).match(/^[ \t]*/) ?? [''])[0] + '    ';
    nextRoot = rootCode.slice(0, insertion) + `\n${indent}${kotlinClasspath}` + rootCode.slice(insertion);
  }

  const applicationPlugin = /apply\s+plugin\s*:\s*['"]com\.android\.application['"]/;
  if (!applicationPlugin.test(appCode)) {
    fail('Plugin com.android.application não encontrado em android/app/build.gradle.');
  }
  const kotlinPlugin = /apply\s+plugin\s*:\s*['"]org\.jetbrains\.kotlin\.android['"]/;
  let nextApp = appCode;
  if (!kotlinPlugin.test(appCode)) {
    const match = applicationPlugin.exec(appCode);
    const end = match.index + match[0].length;
    const eol = appCode.includes('\r\n') ? '\r\n' : '\n';
    nextApp = appCode.slice(0, end) + `${eol}apply plugin: 'org.jetbrains.kotlin.android'` + appCode.slice(end);
  }

  return { root: nextRoot, app: nextApp };
}

// Execução principal: todas as validações acontecem antes da gravação.
if (!fs.existsSync(source)) fail('Plugin Kotlin de origem não encontrado.');
if (!fs.existsSync(androidApp)) fail('Execute npx cap add android antes deste script.');

const coreDist = path.join(root, 'node_modules/@capacitor/core/dist');
const coreEntry = path.join(coreDist, 'index.js');
const webDir = path.join(root, 'www');
if (!fs.existsSync(coreEntry)) {
  fail('Capacitor Core não encontrado. Execute npm install antes da preparação.');
}
if (!fs.existsSync(webDir)) fail('Diretório www não encontrado.');
if (!fs.existsSync(rootGradle) || !fs.existsSync(appGradle)) {
  fail('Arquivos android/build.gradle e android/app/build.gradle não encontrados.');
}

const gradle = prepareKotlinGradle(read(rootGradle), read(appGradle));
const pluginCode = read(source);
validatePlugin(pluginCode);

const hasJava = fs.existsSync(javaActivity);
const hasKotlin = fs.existsSync(kotlinActivity);
if (hasJava === hasKotlin) {
  fail('É necessário existir exatamente uma MainActivity: Java ou Kotlin.');
}

const activityPath = hasJava ? javaActivity : kotlinActivity;
const language = hasJava ? 'java' : 'kotlin';
const originalActivity = read(activityPath);
const updatedActivity = prepareActivity(originalActivity, language);

if (fs.existsSync(destination)) {
  const existingPlugin = read(destination);
  if (existingPlugin !== pluginCode) {
    fail(
      'Já existe um plugin diferente no Android. ' +
      'Nenhum arquivo foi alterado; revise a diferença manualmente.'
    );
  }
}

const changes = [];
if (gradle.root !== read(rootGradle)) changes.push({ path: rootGradle, content: gradle.root });
if (gradle.app !== read(appGradle)) changes.push({ path: appGradle, content: gradle.app });
if (!fs.existsSync(destination)) changes.push({ path: destination, content: pluginCode });
if (updatedActivity !== originalActivity) changes.push({ path: activityPath, content: updatedActivity });

// O HTML é estático: inclui os módulos ESM do Capacitor Core em www para que
// registerPlugin() funcione sem bundler e sem depender do antigo Capacitor.Plugins.
function collectJavaScript(directory, relative = '') {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const rel = path.join(relative, entry.name);
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...collectJavaScript(absolute, rel));
    else if (entry.isFile() && entry.name.endsWith('.js')) found.push({ absolute, relative: rel });
  }
  return found;
}

const vendorRoot = path.join(webDir, 'vendor/capacitor-core');
for (const file of collectJavaScript(coreDist)) {
  const sourceText = read(file.absolute);
  // O ESM publicado para Node pode usar imports relativos sem extensão.
  // WebView resolve módulos como navegador e exige o sufixo .js.
  const browserText = sourceText.replace(
    /(\bfrom\s*|\bimport\s*)['"]((?:\.{1,2})\/[^'"]+)['"]/g,
    (match, prefix, specifier) => {
      if (/\.[a-z0-9]+$/i.test(specifier)) return match;
      const candidate = path.resolve(path.dirname(file.absolute), `${specifier}.js`);
      return fs.existsSync(candidate)
        ? `${prefix}'${specifier}.js'`
        : match;
    }
  );
  changes.push({
    path: path.join(vendorRoot, file.relative),
    content: browserText
  });
}

const bridgeModule = `import { Capacitor, registerPlugin } from './vendor/capacitor-core/index.js';

const KEJUpdater = registerPlugin('KEJUpdater');
window.KEJUpdater = KEJUpdater;
window.KEJUpdaterAvailable =
  Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('KEJUpdater');
window.dispatchEvent(new Event('kej-updater-ready'));
`;
changes.push({
  path: path.join(webDir, 'kej-updater-bridge.js'),
  content: bridgeModule
});

commitFiles(changes);

console.log('[KEJ Atualizador] Plugin validado e preparado.');
console.log(`[KEJ Atualizador] MainActivity: ${activityPath}`);
console.log('[KEJ Atualizador] Kotlin Gradle plugin configurado.');
console.log(`[KEJ Atualizador] Arquivos modificados: ${changes.length}`);
console.log('[KEJ Atualizador] Preparação concluída.');
