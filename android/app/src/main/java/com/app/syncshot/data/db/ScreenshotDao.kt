package com.app.syncshot.data.db

import androidx.paging.PagingSource
import androidx.room.Dao
import androidx.room.Query
import androidx.room.Upsert

@Dao
interface ScreenshotDao {
    /** Older builds could leave several optimistic IDs for the same bytes.
     * Prefer a complete synced row, then a stable newest row. Keep originals;
     * deduplicate before Paging applies LIMIT/OFFSET, not inside the UI. */
    @Query("""
        SELECT s.* FROM screenshots AS s
        WHERE s.sha256 = '' OR s.id = (
            SELECT candidate.id FROM screenshots AS candidate
            WHERE candidate.sha256 = s.sha256 AND candidate.deviceUid = s.deviceUid
            ORDER BY CASE candidate.status WHEN 'full' THEN 2 WHEN 'thumb' THEN 1 ELSE 0 END DESC,
                candidate.createdAt DESC, candidate.id DESC
            LIMIT 1
        )
        ORDER BY s.createdAt DESC, s.id DESC
    """)
    fun pagingSource(): PagingSource<Int, ScreenshotEntity>

    @Upsert
    suspend fun upsertAll(items: List<ScreenshotEntity>)

    @Query("DELETE FROM screenshots WHERE sha256 = :sha AND id != :canonicalId AND status = 'local'")
    suspend fun removeLocalDuplicates(sha: String, canonicalId: String)

    @Query("SELECT * FROM screenshots WHERE status = 'local'")
    suspend fun localPreviews(): List<ScreenshotEntity>

    @Query("DELETE FROM screenshots WHERE id = :id OR (:sha != '' AND sha256 = :sha)")
    suspend fun deleteImage(sha: String, id: String)

    @Query("SELECT * FROM screenshots WHERE id = :id")
    suspend fun byId(id: String): ScreenshotEntity?

    @Query("DELETE FROM screenshots WHERE id = :id AND status = 'local' AND (thumbPath IS NULL OR thumbPath = '') AND (fullPath IS NULL OR fullPath = '')")
    suspend fun deleteMissingLocal(id: String)

    @Query("DELETE FROM screenshots WHERE id = :id")
    suspend fun deleteById(id: String)

    /** Reconcile a fresh Firestore snapshot into Room: drop any local row that
     *  falls within the snapshot's time window (createdAt >= the oldest doc it
     *  carries) but is absent from it — i.e. deleted on another device. Bounded
     *  to the window so it never wipes paged history beyond the 100-doc listener.
     *  Caller must pass a non-empty `ids`. */
    // Reconcile queries never touch status="local" rows — those are optimistic,
    // just-captured shots that haven't synced to Firestore yet, so they're absent
    // from any server snapshot by definition and must not be pruned.

    @Query("DELETE FROM screenshots WHERE createdAt >= :minCreated AND id NOT IN (:ids) AND status != 'local'")
    suspend fun pruneWithinWindow(ids: List<String>, minCreated: Long)

    /** Full reconcile: drop every synced row absent from `ids`. Only safe when the
     *  caller knows `ids` is the complete server set (the listener returned fewer
     *  docs than its page limit, i.e. it reached the end of the collection), so
     *  bulk-deleted shots beyond the page window are cleared instead of lingering.
     *  Caller must pass a non-empty `ids` (use [clearSynced] for the empty case). */
    @Query("DELETE FROM screenshots WHERE id NOT IN (:ids) AND status != 'local'")
    suspend fun keepOnly(ids: List<String>)

    /** Drop all synced rows (empty server set) while keeping un-synced local ones. */
    @Query("DELETE FROM screenshots WHERE status != 'local'")
    suspend fun clearSynced()

    @Query("DELETE FROM screenshots")
    suspend fun clear()
}
