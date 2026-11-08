package br.com.kej.gestao.updater

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import com.getcapacitor.*
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import androidx.activity.result.ActivityResult
import java.io.BufferedInputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest
import java.util.zip.ZipInputStream

/**
 * KEJ Atualizador V8.1 — integração Android conservadora.
 *
 * Seleciona e inspeciona pacotes ZIP em armazenamento privado.
 * Não instala conteúdo, não migra dados e não acessa o banco do KEJ Gestão.
 * O limite de extração é intencionalmente conservador (256 MiB).
 * ZIP64 não é certificado nesta implementação.
 */
@CapacitorPlugin(name = "KEJUpdater")
class KEJUpdaterPlugin : Plugin() {

    companion object {
        private const val MAX_EXTRACTED_BYTES = 256L * 1024L * 1024L
        private const val MAX_ENTRIES = 10_000
        private const val BUFFER_SIZE = 64 * 1024
    }

    private var selected: Uri? = null
    private var selectedPermissionPersisted = false
    private var selectedName: String = "pacote.zip"

    private val selectionPreferences by lazy {
        context.getSharedPreferences("kej_updater_selection", Context.MODE_PRIVATE)
    }

    private fun documentName(uri: Uri): String {
        return try {
            context.contentResolver.query(
                uri,
                arrayOf(OpenableColumns.DISPLAY_NAME),
                null,
                null,
                null
            )?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (index >= 0) cursor.getString(index) else null
                } else null
            }?.takeIf { it.isNotBlank() } ?: (uri.lastPathSegment ?: "pacote.zip")
        } catch (_: Exception) {
            uri.lastPathSegment ?: "pacote.zip"
        }
    }

    /**
     * Recupera somente URIs para as quais o Android ainda confirma uma
     * permissão SAF persistente de leitura. A referência não é confiada
     * apenas porque existe nas preferências.
     */
    private fun restoreSelectedUri(): Uri? {
        val rawUri = selectionPreferences.getString("selected_uri", null)
        if (rawUri.isNullOrBlank()) {
            selected = null
            selectedPermissionPersisted = false
            selectedName = "pacote.zip"
            return null
        }

        val uri = try {
            Uri.parse(rawUri)
        } catch (_: Exception) {
            null
        }

        val permissionValid = uri != null &&
            context.contentResolver.persistedUriPermissions.any {
                it.uri == uri && it.isReadPermission
            }

        if (!permissionValid) {
            selected = null
            selectedPermissionPersisted = false
            selectedName = "pacote.zip"
            selectionPreferences.edit()
                .remove("selected_uri")
                .remove("selected_name")
                .commit()
            return null
        }

        selected = uri
        selectedPermissionPersisted = true
        selectedName = selectionPreferences.getString("selected_name", null)
            ?.takeIf { it.isNotBlank() } ?: documentName(uri!!)
        return uri
    }

    @PluginMethod
    fun choosePackage(call: PluginCall) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "application/zip"
            addFlags(
                Intent.FLAG_GRANT_READ_URI_PERMISSION or
                    Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
            )
        }
        startActivityForResult(call, intent, "packagePicked")
    }

    @ActivityCallback
    private fun packagePicked(call: PluginCall, result: ActivityResult?) {
        val data = result?.data
        val uri = data?.data

        if (uri == null) {
            // Cancelar o seletor não apaga uma seleção anterior ainda válida.
            call.reject("Seleção cancelada ou pacote não informado.")
            return
        }

        val readGranted =
            data.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0

        var persisted = false
        if (readGranted) {
            try {
                context.contentResolver.takePersistableUriPermission(
                    uri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION
                )
                persisted = true
            } catch (_: SecurityException) {
                persisted = false
            } catch (_: IllegalArgumentException) {
                persisted = false
            }
        }

        // A URI pode ser usada nesta sessão mesmo se a permissão persistente
        // não estiver disponível. O estado é informado explicitamente ao JS.
        selected = uri
        selectedPermissionPersisted = persisted
        selectedName = documentName(uri)
        val selectionSaved = selectionPreferences.edit()
            .putString("selected_uri", uri.toString())
            .putString("selected_name", selectedName)
            .putBoolean("permission_persisted", persisted)
            .commit()

        call.resolve(
            JSObject()
                .put("selected", true)
                .put("name", selectedName)
                .put("permissionPersisted", persisted)
                .put("selectionSaved", selectionSaved)
        )
    }

    @PluginMethod
    fun getSelectedPackage(call: PluginCall) {
        val uri = selected ?: restoreSelectedUri()
        if (uri == null) {
            call.resolve(
                JSObject()
                    .put("selected", false)
                    .put("permissionPersisted", false)
            )
            return
        }

        call.resolve(
            JSObject()
                .put("selected", true)
                .put("name", selectedName)
                .put("permissionPersisted", selectedPermissionPersisted)
        )
    }

    private fun recoverStaging(staging: File, temporary: File, previous: File) {
        if (!staging.exists() && previous.exists()) {
            if (!previous.renameTo(staging)) {
                throw IOException(
                    "Não foi possível recuperar a preparação anterior. " +
                        "A cópia continua preservada em staging.previous."
                )
            }
        }

        if (staging.exists() && previous.exists() && !previous.deleteRecursively()) {
            throw IOException("Não foi possível remover a staging.previous antiga.")
        }

        if (temporary.exists() && !temporary.deleteRecursively()) {
            throw IOException("Não foi possível limpar a staging temporária antiga.")
        }
    }

    @PluginMethod
    fun inspectAndStage(call: PluginCall) {
        val uri = selected ?: restoreSelectedUri()
        if (uri == null) {
            call.reject(
                "Nenhum pacote recuperável. Selecione novamente o ZIP e conceda acesso persistente."
            )
            return
        }

        val maxBytes = call.getLong("maxExtractedBytes", MAX_EXTRACTED_BYTES) ?: MAX_EXTRACTED_BYTES
        val maxEntries = call.getInt("maxEntries", MAX_ENTRIES) ?: MAX_ENTRIES

        if (maxBytes <= 0L || maxBytes > MAX_EXTRACTED_BYTES) {
            call.reject("Limite de bytes inválido. Máximo permitido: 256 MiB.")
            return
        }
        if (maxEntries <= 0 || maxEntries > MAX_ENTRIES) {
            call.reject("Quantidade de entradas inválida. Máximo permitido: 10000.")
            return
        }

        val root = File(context.filesDir, "kej-updater")
        val staging = File(root, "staging")
        val temporary = File(root, "staging.tmp")
        val previous = File(root, "staging.previous")

        try {
            if (!root.exists() && !root.mkdirs()) {
                throw IOException("Não foi possível criar a pasta privada.")
            }

            recoverStaging(staging, temporary, previous)

            if (!temporary.mkdirs()) {
                throw IOException("Não foi possível criar a área temporária.")
            }

            var totalBytes = 0L
            var entryCount = 0
            val digest = MessageDigest.getInstance("SHA-256")
            val seenEntries = mutableSetOf<String>()
            val files = mutableSetOf<String>()
            val directories = mutableSetOf<String>()

            context.contentResolver.openInputStream(uri).use { raw ->
                if (raw == null) throw IOException("Não foi possível abrir o pacote.")

                ZipInputStream(BufferedInputStream(raw, BUFFER_SIZE)).use { zip ->
                    val buffer = ByteArray(BUFFER_SIZE)

                    while (true) {
                        val entry = zip.nextEntry ?: break
                        entryCount++
                        if (entryCount > maxEntries) {
                            throw IOException("Quantidade de entradas excedida.")
                        }

                        val originalName = entry.name.replace('\\', '/')
                        val isDirectory = entry.isDirectory || originalName.endsWith("/")
                        val name = if (isDirectory) originalName.trimEnd('/') else originalName

                        if (
                            name.isBlank() ||
                            name.startsWith("/") ||
                            name.matches(Regex("^[A-Za-z]:.*"))
                        ) {
                            throw IOException("Caminho absoluto ou vazio rejeitado.")
                        }

                        val parts = name.split('/')
                        if (parts.any { it.isBlank() || it == "." || it == ".." }) {
                            throw IOException("Caminho inseguro rejeitado.")
                        }

                        val normalized = parts.joinToString("/")
                        if (!seenEntries.add(normalized)) {
                            throw IOException("Entrada ZIP duplicada: $normalized")
                        }

                        // Impede que um arquivo seja pai de outra entrada e
                        // que uma pasta seja posteriormente sobrescrita como arquivo.
                        val parentPaths = (0 until parts.size - 1)
                            .map { index -> parts.take(index + 1).joinToString("/") }

                        if (parentPaths.any { it in files }) {
                            throw IOException("Conflito de caminho no pacote: $normalized")
                        }
                        if (isDirectory && normalized in files) {
                            throw IOException("Conflito entre arquivo e pasta: $normalized")
                        }
                        if (
                            !isDirectory &&
                            (normalized in directories ||
                                directories.any { it.startsWith("$normalized/") })
                        ) {
                            throw IOException("Conflito entre pasta e arquivo: $normalized")
                        }

                        if (isDirectory) {
                            directories.add(normalized)
                        } else {
                            files.add(normalized)
                        }

                        val output = File(temporary, normalized).canonicalFile
                        val temporaryCanonical = temporary.canonicalFile
                        if (
                            output.path != temporaryCanonical.path &&
                            !output.path.startsWith(temporaryCanonical.path + File.separator)
                        ) {
                            throw IOException("Entrada fora da área temporária.")
                        }

                        if (isDirectory) {
                            if (!output.exists() && !output.mkdirs()) {
                                throw IOException("Não foi possível criar diretório.")
                            }
                        } else {
                            val parent = output.parentFile
                            if (parent != null && !parent.exists() && !parent.mkdirs()) {
                                throw IOException("Não foi possível criar diretório de destino.")
                            }

                            FileOutputStream(output).use { out ->
                                while (true) {
                                    val count = zip.read(buffer)
                                    if (count < 0) break

                                    if (count.toLong() > maxBytes - totalBytes) {
                                        throw IOException("Limite de extração excedido.")
                                    }

                                    totalBytes += count.toLong()
                                    digest.update(buffer, 0, count)
                                    out.write(buffer, 0, count)
                                }
                                out.fd.sync()
                            }
                        }

                        zip.closeEntry()
                    }
                }
            }

            if (entryCount == 0) throw IOException("ZIP vazio.")

            // A staging válida só é substituída depois da extração completa.
            val hadPrevious = staging.exists()
            if (hadPrevious && !staging.renameTo(previous)) {
                throw IOException("Não foi possível preservar a staging anterior.")
            }

            if (!temporary.renameTo(staging)) {
                if (hadPrevious && !previous.renameTo(staging)) {
                    throw IOException(
                        "Falha ao finalizar staging e ao restaurar a anterior. " +
                            "A cópia anterior permanece em staging.previous."
                    )
                }
                throw IOException("Não foi possível finalizar a nova staging.")
            }

            // Se a limpeza falhar, staging já está confirmada e previous
            // fica preservada para recuperação/limpeza na próxima execução.
            val previousRemoved = !previous.exists() || previous.deleteRecursively()

            val digestHex = digest.digest().joinToString("") {
                "%02x".format(it.toInt() and 0xff)
            }

            call.resolve(
                JSObject()
                    .put("staged", true)
                    .put("entries", entryCount)
                    .put("bytesWritten", totalBytes)
                    .put("streamDigest", digestHex)
                    .put("permissionPersisted", selectedPermissionPersisted)
                    .put("previousCleanupPending", !previousRemoved)
                    .put(
                        "warning",
                        "Conteúdo apenas preparado, não instalado. " +
                            "Limite de 256 MiB. ZIP64 não certificado."
                    )
            )
        } catch (e: Exception) {
            try {
                if (!staging.exists() && previous.exists()) {
                    previous.renameTo(staging)
                }
                if (temporary.exists()) temporary.deleteRecursively()
            } catch (_: Exception) {
                // Preserva o erro original e não apaga staging.previous.
            }

            call.reject(
                "Falha na inspeção: ${e.message ?: "erro desconhecido"}",
                e
            )
        }
    }

    @PluginMethod
    fun clearStaging(call: PluginCall) {
        val root = File(context.filesDir, "kej-updater")
        val staging = File(root, "staging")
        val temporary = File(root, "staging.tmp")
        val previous = File(root, "staging.previous")

        try {
            val cleared =
                (!staging.exists() || staging.deleteRecursively()) &&
                (!temporary.exists() || temporary.deleteRecursively()) &&
                (!previous.exists() || previous.deleteRecursively())

            call.resolve(JSObject().put("cleared", cleared))
        } catch (e: Exception) {
            call.reject("Não foi possível limpar a preparação.", e)
        }
    }
}
