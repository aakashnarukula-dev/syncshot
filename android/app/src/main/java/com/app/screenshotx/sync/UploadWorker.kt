package com.app.screenshotx.sync

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
import com.app.screenshotx.data.FirebaseRepo
import java.util.concurrent.TimeUnit

/** Offline-safe screenshot publish: reads the captured image bytes and hands them
 *  to FirebaseRepo (sha256 dedupe -> thumb -> full). Retries on failure. */
class UploadWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        val uriStr = inputData.getString("uri") ?: return Result.failure()
        return try {
            val bytes = applicationContext.contentResolver.openInputStream(Uri.parse(uriStr))
                ?.use { it.readBytes() } ?: return Result.retry()
            FirebaseRepo.publishScreenshot(applicationContext, bytes)
            Result.success()
        } catch (e: Exception) {
            Result.retry()
        }
    }

    companion object {
        fun enqueue(ctx: Context, uri: Uri) {
            val req = OneTimeWorkRequestBuilder<UploadWorker>()
                .setInputData(workDataOf("uri" to uri.toString()))
                .setConstraints(
                    Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
                )
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(ctx).enqueue(req)
        }
    }
}
