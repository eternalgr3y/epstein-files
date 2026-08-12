import unittest

from audit_archive_integrity import (
    document_r2_key,
    house_native_target,
    house_page_targets,
    normalize_media_type,
    parse_wrangler_json,
)


class ArchiveIntegrityAuditTests(unittest.TestCase):
    def test_document_r2_key_normalizes_windows_and_posix_paths(self):
        self.assertEqual(
            document_r2_key(r"C:\archive\epstein-files\raw\batch\file.pdf"),
            "raw/batch/file.pdf",
        )
        self.assertEqual(
            document_r2_key("/archive/epstein-files/extracted/data-set/file.pdf"),
            "extracted/data-set/file.pdf",
        )
        self.assertIsNone(document_r2_key("/archive/unrelated/file.pdf"))

    def test_house_pages_cross_the_two_thousand_page_folder_boundary(self):
        targets = house_page_targets("HOUSE_OVERSIGHT_012476", 2)
        self.assertEqual(
            [target.key for target in targets],
            [
                "house-oversight/IMAGES/001/HOUSE_OVERSIGHT_012476.jpg",
                "house-oversight/IMAGES/002/HOUSE_OVERSIGHT_012477.jpg",
            ],
        )

    def test_wrangler_json_parser_ignores_terminal_color_prefixes(self):
        output = '\x1b[32mwrangler\x1b[0m\n[{"results":[{"id":1}],"success":true}]'
        self.assertEqual(parse_wrangler_json(output), [{"id": 1}])

    def test_equivalent_wav_content_types_are_normalized(self):
        self.assertEqual(normalize_media_type("audio/vnd.wave"), "audio/wav")
        self.assertEqual(normalize_media_type("audio/x-wav; charset=binary"), "audio/wav")

    def test_estate_native_video_target_preserves_the_released_container(self):
        target = house_native_target({
            "id": 15999,
            "filename": "HOUSE_OVERSIGHT_026678",
            "title": "IMG_0642.MP4.mov",
            "file_size": 2_504_613,
            "document_type": "video",
            "data_set": "house-oversight-estate",
        })
        self.assertEqual(
            target.key,
            "house-oversight/NATIVES/001/HOUSE_OVERSIGHT_026678.mov",
        )
        self.assertEqual(target.expected_type, "video/quicktime")
        self.assertEqual(target.expected_size, 2_504_613)


if __name__ == "__main__":
    unittest.main()
