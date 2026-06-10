package com.aakash.ssx.sync

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.os.Bundle
import android.widget.Toast
import androidx.core.content.FileProvider
import java.io.File

/** Transparent activity: a foreground moment that can legally set the clipboard
 *  (Android blocks background clipboard writes). Launched from the "Copy" action. */
class CopyActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val path = intent.getStringExtra("file")
        if (path != null) {
            try {
                val file = File(path)
                val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
                val clip = ClipData.newUri(contentResolver, "Screenshot", uri)
                getSystemService(ClipboardManager::class.java).setPrimaryClip(clip)
                Toast.makeText(this, "Copied to clipboard", Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                Toast.makeText(this, "Copy failed", Toast.LENGTH_SHORT).show()
            }
        }
        finish()
    }
}
