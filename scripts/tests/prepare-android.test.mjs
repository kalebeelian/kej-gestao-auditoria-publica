import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptSource = path.resolve(here, '../prepare-android.mjs');

const plugin = `package br.com.kej.gestao.updater

import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "KEJUpdater")
class KEJUpdaterPlugin : Plugin() {
    fun choosePackage(call: PluginCall) {}
    fun inspectAndStage(call: PluginCall) {}
    fun clearStaging(call: PluginCall) {}
}
`;

function fixture(activityFiles) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kej-prepare-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(scriptSource, path.join(root, 'scripts/prepare-android.mjs'));

  const source = path.join(
    root,
    'native-plugin/src/main/java/br/com/kej/gestao/updater/KEJUpdaterPlugin.kt'
  );
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, plugin);

  const app = path.join(root, 'android/app');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(root, 'android/build.gradle'), `buildscript {
    repositories { google(); mavenCentral() }
    dependencies {
        classpath 'com.android.tools.build:gradle:8.2.1'
    }
}
`);
  fs.writeFileSync(path.join(app, 'build.gradle'), `apply plugin: 'com.android.application'

android { namespace 'br.com.kej.gestao' }
`);
  const mockCore = path.join(root, 'node_modules/@capacitor/core/dist');
  fs.mkdirSync(mockCore, { recursive: true });
  fs.writeFileSync(path.join(mockCore, 'index.js'), "export { registerPlugin, Capacitor } from './runtime';\\n");
  fs.writeFileSync(path.join(mockCore, 'runtime.js'), 'export const registerPlugin = () => ({}); export const Capacitor = {};\\n');
  fs.mkdirSync(path.join(root, 'www'), { recursive: true });

  for (const [relative, content] of Object.entries(activityFiles)) {
    const target = path.join(app, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }

  return root;
}

function run(root, expected = 0) {
  try {
    execFileSync(process.execPath, ['scripts/prepare-android.mjs'], {
      cwd: root,
      stdio: 'pipe'
    });
    assert.equal(expected, 0);
    return '';
  } catch (error) {
    assert.equal(expected, 1, error.stdout?.toString() + error.stderr?.toString());
    return error.stderr?.toString() ?? '';
  }
}

const javaPath = 'src/main/java/br/com/kej/gestao/MainActivity.java';
const kotlinPath = 'src/main/java/br/com/kej/gestao/MainActivity.kt';

test('Java: registra plugin antes de super.onCreate', () => {
  const root = fixture({
    [javaPath]: `package br.com.kej.gestao;
import com.getcapacitor.BridgeActivity;
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
    }
}
`
  });
  run(root);
  const result = fs.readFileSync(path.join(root, 'android/app', javaPath), 'utf8');
  assert.ok(result.indexOf('registerPlugin(KEJUpdaterPlugin.class);') < result.indexOf('super.onCreate'));
  assert.match(result, /import android\.os\.Bundle;/);
  assert.match(result, /import br\.com\.kej\.gestao\.updater\.KEJUpdaterPlugin;/);
  assert.ok(fs.existsSync(path.join(root, 'www/kej-updater-bridge.js')));
  assert.ok(fs.existsSync(path.join(root, 'www/vendor/capacitor-core/index.js')));
  const bridge = fs.readFileSync(path.join(root, 'www/kej-updater-bridge.js'), 'utf8');
  assert.match(bridge, /registerPlugin\('KEJUpdater'\)/);
  assert.match(bridge, /isPluginAvailable\('KEJUpdater'\)/);
  const rootGradle = fs.readFileSync(path.join(root, 'android/build.gradle'), 'utf8');
  const appGradle = fs.readFileSync(path.join(root, 'android/app/build.gradle'), 'utf8');
  assert.match(rootGradle, /org\.jetbrains\.kotlin:kotlin-gradle-plugin:2\.1\.21/);
  assert.match(appGradle, /apply plugin: 'org\.jetbrains\.kotlin\.android'/);
});

test('Kotlin: registra plugin antes de super.onCreate', () => {
  const root = fixture({
    [kotlinPath]: `package br.com.kej.gestao
import com.getcapacitor.BridgeActivity
class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
    }
}
`
  });
  run(root);
  const result = fs.readFileSync(path.join(root, 'android/app', kotlinPath), 'utf8');
  assert.ok(result.indexOf('registerPlugin(KEJUpdaterPlugin::class.java)') < result.indexOf('super.onCreate'));
  assert.match(result, /import android\.os\.Bundle/);
});

test('Java: suporta onCreate e super na mesma linha', () => {
  const root = fixture({
    [javaPath]: `package br.com.kej.gestao;
import com.getcapacitor.BridgeActivity;
public class MainActivity extends BridgeActivity {
  @Override public void onCreate(Bundle savedInstanceState) { super.onCreate(savedInstanceState); }
}
`
  });
  run(root);
  const result = fs.readFileSync(path.join(root, 'android/app', javaPath), 'utf8');
  assert.ok(result.indexOf('registerPlugin(KEJUpdaterPlugin.class);') < result.indexOf('super.onCreate'));
});


test('Java: prepara MainActivity compacta sem rejeitar fechamento na mesma linha', () => {
  const root = fixture({
    [javaPath]: `package br.com.kej.gestao;\nimport com.getcapacitor.BridgeActivity;\npublic class MainActivity extends BridgeActivity {}`
  });
  run(root);
  const result = fs.readFileSync(path.join(root, 'android/app', javaPath), 'utf8');
  assert.match(result, /public class MainActivity extends BridgeActivity \{\n[\s\S]*registerPlugin\(KEJUpdaterPlugin\.class\);[\s\S]*\n\}/);
  assert.ok(result.indexOf('registerPlugin(KEJUpdaterPlugin.class);') < result.indexOf('super.onCreate'));
});

test('Import preexistente sem registro não impede a inclusão', () => {
  const root = fixture({
    [javaPath]: `package br.com.kej.gestao;
import com.getcapacitor.BridgeActivity;
import br.com.kej.gestao.updater.KEJUpdaterPlugin;
public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
    }
}
`
  });
  run(root);
  const result = fs.readFileSync(path.join(root, 'android/app', javaPath), 'utf8');
  assert.equal((result.match(/registerPlugin\(KEJUpdaterPlugin\.class\)/g) ?? []).length, 1);
});

test('É idempotente: segunda execução não duplica registro', () => {
  const root = fixture({
    [javaPath]: `package br.com.kej.gestao;
import com.getcapacitor.BridgeActivity;
public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
    }
}
`
  });
  run(root);
  const target = path.join(root, 'android/app', javaPath);
  const first = fs.readFileSync(target, 'utf8');
  run(root);
  const second = fs.readFileSync(target, 'utf8');
  assert.equal(second, first);
  const rootGradle = fs.readFileSync(path.join(root, 'android/build.gradle'), 'utf8');
  const appGradle = fs.readFileSync(path.join(root, 'android/app/build.gradle'), 'utf8');
  assert.equal((rootGradle.match(/kotlin-gradle-plugin/g) ?? []).length, 1);
  assert.equal((appGradle.match(/org\.jetbrains\.kotlin\.android/g) ?? []).length, 1);
});

test('Ignora comentário que menciona KEJUpdaterPlugin', () => {
  const root = fixture({
    [javaPath]: `package br.com.kej.gestao;
import com.getcapacitor.BridgeActivity;
public class MainActivity extends BridgeActivity {
    // KEJUpdaterPlugin foi discutido, mas ainda não foi registrado.
}
`
  });
  run(root);
  const result = fs.readFileSync(path.join(root, 'android/app', javaPath), 'utf8');
  assert.match(result, /registerPlugin\(KEJUpdaterPlugin\.class\)/);
});

test('Preserva CRLF', () => {
  const root = fixture({
    [javaPath]: `package br.com.kej.gestao;\r\nimport com.getcapacitor.BridgeActivity;\r\npublic class MainActivity extends BridgeActivity {\r\n}\r\n`
  });
  run(root);
  const result = fs.readFileSync(path.join(root, 'android/app', javaPath), 'utf8');
  assert.ok(result.includes('\r\n'));
  assert.equal(result.replace(/\r\n/g, '').includes('\n'), false);
});

test('Falha se Java e Kotlin coexistirem', () => {
  const root = fixture({
    [javaPath]: `package br.com.kej.gestao;\npublic class MainActivity extends BridgeActivity {}\n`,
    [kotlinPath]: `package br.com.kej.gestao\nclass MainActivity : BridgeActivity()\n`
  });
  const message = run(root, 1);
  assert.match(message, /exatamente uma MainActivity/);
});

test('Falha sem alterar arquivos se plugin de destino for diferente', () => {
  const root = fixture({
    [javaPath]: `package br.com.kej.gestao;
import com.getcapacitor.BridgeActivity;
public class MainActivity extends BridgeActivity {
}
`
  });
  const dest = path.join(root, 'android/app/src/main/java/br/com/kej/gestao/updater/KEJUpdaterPlugin.kt');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, 'plugin diferente');
  const activity = fs.readFileSync(path.join(root, 'android/app', javaPath), 'utf8');
  const message = run(root, 1);
  assert.match(message, /plugin diferente/);
  assert.equal(fs.readFileSync(path.join(root, 'android/app', javaPath), 'utf8'), activity);
});

test('Falha sem Capacitor Core instalado antes de alterar arquivos', () => {
  const root = fixture({
    [javaPath]: `package br.com.kej.gestao;
import com.getcapacitor.BridgeActivity;
public class MainActivity extends BridgeActivity {
}
`
  });
  fs.rmSync(path.join(root, 'node_modules/@capacitor/core'), { recursive: true, force: true });
  const target = path.join(root, 'android/app', javaPath);
  const before = fs.readFileSync(target, 'utf8');
  const message = run(root, 1);
  assert.match(message, /Execute npm install/);
  assert.equal(fs.readFileSync(target, 'utf8'), before);
  assert.equal(
    fs.existsSync(path.join(root, 'android/app/src/main/java/br/com/kej/gestao/updater/KEJUpdaterPlugin.kt')),
    false
  );
});
