package com.aakash.ssx.sync

import android.content.Context
import android.net.Uri
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import com.aakash.ssx.data.HubClient
import com.aakash.ssx.data.Hashing
import com.aakash.ssx.data.Prefs
import java.util.concurrent.TimeUnit

class UploadWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        val uriStr = inputData.getString("uri") ?: return Result.failure()
        val name = inputData.getString("name") ?: "screenshot.png"
        val prefs = Prefs(applicationContext)
        val base = prefs.baseUrl ?: return Result.failure()
        return try {
            val bytes = applicationContext.contentResolver.openInputStream(Uri.parse(uriStr))
                ?.use { it.readBytes() } ?: return Result.retry()
            val hash = Hashing.sha256(bytes)
            HubClient(base, prefs.token).uploadBytes(bytes, hash, name, "android")
            Result.success()
        } catch (e: Exception) {
            Result.retry()
        }
    }

    companion object {
        fun enqueue(ctx: Context, uri: Uri, name: String) {
            val req = OneTimeWorkRequestBuilder<UploadWorker>()
                .setInputData(workDataOf("uri" to uri.toString(), "name" to name))
                .setConstraints(
                    Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
                )
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(ctx).enqueue(req)
        }
    }
}
