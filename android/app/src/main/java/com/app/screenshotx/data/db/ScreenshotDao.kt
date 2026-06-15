package com.app.screenshotx.data.db

import androidx.paging.PagingSource
import androidx.room.Dao
import androidx.room.Query
import androidx.room.Upsert

@Dao
interface ScreenshotDao {
    @Query("SELECT * FROM screenshots ORDER BY createdAt DESC")
    fun pagingSource(): PagingSource<Int, ScreenshotEntity>

    @Upsert
    suspend fun upsertAll(items: List<ScreenshotEntity>)

    @Query("SELECT * FROM screenshots WHERE id = :id")
    suspend fun byId(id: String): ScreenshotEntity?

    @Query("DELETE FROM screenshots WHERE id = :id")
    suspend fun deleteById(id: String)

    /** Reconcile a fresh Firestore snapshot into Room: drop any local row that
     *  falls within the snapshot's time window (createdAt >= the oldest doc it
     *  carries) but is absent from it — i.e. deleted on another device. Bounded
     *  to the window so it never wipes paged history beyond the 100-doc listener.
     *  Caller must pass a non-empty `ids`. */
    @Query("DELETE FROM screenshots WHERE createdAt >= :minCreated AND id NOT IN (:ids)")
    suspend fun pruneWithinWindow(ids: List<String>, minCreated: Long)

    @Query("DELETE FROM screenshots")
    suspend fun clear()
}
