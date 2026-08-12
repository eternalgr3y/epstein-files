import unittest
from unittest.mock import patch

from audit_archive_integrity import (
    InventoryObject,
    Target,
    cloudflare_get,
    compare_targets,
    document_r2_key,
    house_native_target,
    house_page_targets,
    normalize_media_type,
    parse_r2_list_page,
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

    def test_r2_inventory_page_preserves_size_type_and_cursor(self):
        objects, cursor = parse_r2_list_page({
            "success": True,
            "result": [{
                "key": "video.mp4",
                "size": 2048,
                "http_metadata": {"contentType": "video/mp4"},
            }],
            "result_info": {"is_truncated": True, "cursor": "next-page"},
        })

        self.assertEqual(
            objects,
            [InventoryObject("video.mp4", 2048, "video/mp4")],
        )
        self.assertEqual(cursor, "next-page")

    def test_inventory_comparison_reports_missing_zero_and_size_mismatch(self):
        targets = {
            "missing.pdf": Target("missing.pdf", "document", "1", 10, "application/pdf"),
            "empty.mp4": Target("empty.mp4", "document", "2", None, "video/mp4"),
            "wrong.wav": Target("wrong.wav", "document", "3", 20, "audio/wav"),
        }
        inventory = {
            "empty.mp4": InventoryObject("empty.mp4", 0, "video/mp4"),
            "wrong.wav": InventoryObject("wrong.wav", 19, "audio/x-wav"),
        }

        findings = compare_targets(targets, inventory)

        self.assertEqual(
            [(item["key"], item["problem"]) for item in findings],
            [
                ("missing.pdf", "missing"),
                ("wrong.wav", "size-mismatch"),
                ("empty.mp4", "zero-byte"),
            ],
        )

    def test_request_budget_stops_inventory_before_network_io(self):
        from qa_request_budget import RequestBudget, RequestBudgetExceeded

        with patch("audit_archive_integrity.urllib.request.urlopen") as urlopen:
            with self.assertRaises(RequestBudgetExceeded):
                cloudflare_get(
                    "https://api.cloudflare.com/client/v4/example",
                    "secret-token",
                    RequestBudget(0),
                    timeout=1,
                    retries=0,
                    label="R2 inventory page",
                )

        urlopen.assert_not_called()


if __name__ == "__main__":
    unittest.main()
