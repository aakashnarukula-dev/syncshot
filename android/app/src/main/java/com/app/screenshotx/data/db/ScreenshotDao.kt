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

    @Query("DELETE FROM screenshots")
    suspend fun clear()
}
