import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginPath = path.resolve(here, '../../native-plugin/src/main/java/br/com/kej/gestao/updater/KEJUpdaterPlugin.kt');
const source = fs.readFileSync(pluginPath, 'utf8');

test('Plugin Kotlin: importa os tipos ActivityCallback e ActivityResult do Capacitor/AndroidX', () => {
  assert.match(source, /import com\.getcapacitor\.annotation\.ActivityCallback/);
  assert.match(source, /import androidx\.activity\.result\.ActivityResult/);
});

test('Plugin Kotlin: aplica limites padrão quando parâmetros são omitidos', () => {
  assert.match(source, /getLong\("maxExtractedBytes", MAX_EXTRACTED_BYTES\) \?\: MAX_EXTRACTED_BYTES/);
  assert.match(source, /getInt\("maxEntries", MAX_ENTRIES\) \?\: MAX_ENTRIES/);
});

test('Plugin Kotlin: calcula caminhos pais sem dropLast em IntRange', () => {
  assert.match(source, /0 until parts\.size - 1/);
  assert.doesNotMatch(source, /parts\.indices\s*\.dropLast/);
});


test('Plugin Kotlin: persiste a URI e o nome do documento em preferências privadas', () => {
  assert.match(source, /getSharedPreferences\("kej_updater_selection"/);
  assert.match(source, /putString\("selected_uri", uri\.toString\(\)\)/);
  assert.match(source, /putString\("selected_name", selectedName\)/);
  assert.match(source, /\.commit\(\)/);
});

test('Plugin Kotlin: só recupera URI com permissão SAF persistente ainda válida', () => {
  assert.match(source, /persistedUriPermissions\.any/);
  assert.match(source, /it\.uri == uri && it\.isReadPermission/);
  assert.match(source, /fun getSelectedPackage\(call: PluginCall\)/);
});

test('Plugin Kotlin: inspeção tenta recuperar seleção após recriação do processo', () => {
  assert.match(source, /val uri = selected \?: restoreSelectedUri\(\)/);
  assert.match(source, /Nenhum pacote recuperável/);
});
