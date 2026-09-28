"""Exercise the exact Room gallery query against SQLite, including pagination."""
from pathlib import Path
import re
import sqlite3
import unittest

ROOT = Path(__file__).resolve().parents[1]
DAO = ROOT / 'app/src/main/java/com/app/syncshot/data/db/ScreenshotDao.kt'
DELETE_IMAGE = re.search(r'@Query\("(DELETE FROM screenshots WHERE id = :id OR.*?)"\)', DAO.read_text()).group(1)
DELETE_MISSING = re.search(r'@Query\("(DELETE FROM screenshots WHERE id = :id AND status.*?)"\)', DAO.read_text()).group(1)
QUERY = re.search(r'@Query\("""(.*?)"""\)', DAO.read_text(), re.S).group(1).strip()


class GalleryDedupTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.execute('CREATE TABLE screenshots (id TEXT PRIMARY KEY, sha256 TEXT, deviceUid TEXT, createdAt INTEGER, status TEXT, thumbPath TEXT, fullPath TEXT)')

    def tearDown(self):
        self.db.close()

    def add(self, identifier, sha='same', status='local', created=100, uid='user'):
        self.db.execute('INSERT INTO screenshots (id, sha256, deviceUid, createdAt, status) VALUES (?, ?, ?, ?, ?)', (identifier, sha, uid, created, status))

    def ids(self, suffix=''):
        return [row[0] for row in self.db.execute(QUERY + suffix)]

    def test_four_failed_attempts_render_once(self):
        for i in range(4):
            self.add(str(i))
        self.assertEqual(['3'], self.ids())
        self.assertEqual(4, self.db.execute('SELECT COUNT(*) FROM screenshots').fetchone()[0])

    def test_synced_original_wins_over_newer_orphan_preview(self):
        self.add('original', status='full', created=1)
        self.add('retry', created=999)
        self.add('thumbnail', status='thumb', created=999)
        self.assertEqual(['original'], self.ids())

    def test_distinct_images_and_unknown_hashes_stay_visible(self):
        self.add('first', sha='one')
        self.add('second', sha='two')
        self.add('unknown1', sha='')
        self.add('unknown2', sha='')
        self.assertEqual(4, len(self.ids()))

    def test_pages_have_no_duplicate_slots(self):
        for i in range(4):
            self.add('dup' + str(i), created=200)
        self.add('older', sha='different', created=100)
        self.assertEqual(['dup3'], self.ids(' LIMIT 1 OFFSET 0'))
        self.assertEqual(['older'], self.ids(' LIMIT 1 OFFSET 1'))

    def test_deleting_image_removes_every_retry_row(self):
        for i in range(4):
            self.add(str(i))
        self.add('keep', sha='different')
        self.db.execute(DELETE_IMAGE, {'id': '3', 'sha': 'same'})
        self.assertEqual(['keep'], self.ids())

    def test_deleting_unknown_hash_does_not_delete_other_images(self):
        self.add('a', sha='')
        self.add('b', sha='')
        self.db.execute(DELETE_IMAGE, {'id': 'a', 'sha': ''})
        self.assertEqual(['b'], self.ids())

    def test_gray_local_placeholder_is_removed(self):
        self.add('empty')
        self.db.execute(DELETE_MISSING, {'id': 'empty'})
        self.assertEqual([], self.ids())

    def test_repair_cannot_delete_row_that_finished_syncing(self):
        self.add('finished', status='full')
        self.add('remote', sha='remote')
        self.db.execute("UPDATE screenshots SET fullPath = 'cloud/image.png' WHERE id = 'remote'")
        for identifier in ('finished', 'remote'):
            self.db.execute(DELETE_MISSING, {'id': identifier})
        self.assertEqual(2, len(self.ids()))

    def test_accounts_are_not_coalesced(self):
        self.add('a', uid='alice')
        self.add('b', uid='bob')
        self.assertEqual(2, len(self.ids()))


if __name__ == '__main__':
    unittest.main()
