package com.app.syncshot.data

import android.content.Context
import com.app.syncshot.data.db.AppDb
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Old retry rows have no cloud paths. Once their shared cache was deleted,
 * they can never render again. Remove only those empty local placeholders. */
object PreviewRepair {
    suspend fun removeMissing(ctx: Context) = withContext(Dispatchers.IO) {
        val dao = AppDb.get(ctx).screenshots()
        for (row in dao.localPreviews()) {
            if (row.thumbPath.isNullOrBlank() && row.fullPath.isNullOrBlank() &&
                ImageFiles.findReceivedFile(ctx, row.sha256, row.mime) == null &&
                ImageFiles.findSharedFile(ctx, row.sha256, row.mime) == null) {
                dao.deleteMissingLocal(row.id)
            }
        }
    }
}
