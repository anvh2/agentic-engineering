"""Unit tests for comfy_still_lib.py - pure logic only, no ComfyUI required.

Run with: python3 -m unittest benchmarks/phase3/comfy_still_lib_test.py -v
"""
import pathlib
import tempfile
import unittest

import comfy_still_lib as lib


class BuildGraphTests(unittest.TestCase):
    def _graph(self, **overrides):
        kwargs = dict(
            checkpoint_name="realisticVisionV60B1.safetensors",
            reference_image_filename="overview_3.png",
            seed=555,
            filename_prefix="phase3-keyframe-test",
        )
        kwargs.update(overrides)
        return lib.build_graph(**kwargs)

    def test_returns_exactly_ten_nodes(self):
        self.assertEqual(len(self._graph()), 10)

    def test_checkpoint_and_reference_wired_correctly(self):
        graph = self._graph()
        self.assertEqual(graph["1"]["inputs"]["ckpt_name"], "realisticVisionV60B1.safetensors")
        self.assertEqual(graph["2"]["inputs"]["image"], "overview_3.png")

    def test_ipadapter_consumes_checkpoint_model_and_reference_image(self):
        graph = self._graph()
        self.assertEqual(graph["3"]["inputs"]["model"], ["1", 0])
        self.assertEqual(graph["4"]["inputs"]["image"], ["2", 0])
        self.assertEqual(graph["4"]["inputs"]["ipadapter"], ["3", 1])

    def test_sampler_denoise_is_full_txt2img_not_img2img(self):
        graph = self._graph()
        self.assertEqual(graph["8"]["inputs"]["denoise"], 1.0)

    def test_ksampler_conditioning_comes_from_ipadapter_and_text_encoders(self):
        graph = self._graph()
        self.assertEqual(graph["8"]["inputs"]["model"], ["4", 0])
        self.assertEqual(graph["8"]["inputs"]["positive"], ["5", 0])
        self.assertEqual(graph["8"]["inputs"]["negative"], ["6", 0])

    def test_save_image_terminal_node_consumes_decoded_output(self):
        graph = self._graph()
        self.assertEqual(graph["10"]["inputs"]["images"], ["9", 0])
        self.assertEqual(graph["10"]["inputs"]["filename_prefix"], "phase3-keyframe-test")

    def test_seed_is_threaded_through_for_reproducibility(self):
        graph = self._graph(seed=123456)
        self.assertEqual(graph["8"]["inputs"]["seed"], 123456)

    def test_dimensions_are_configurable(self):
        graph = self._graph(width=512, height=768)
        self.assertEqual(graph["7"]["inputs"]["width"], 512)
        self.assertEqual(graph["7"]["inputs"]["height"], 768)

    def test_rejects_out_of_range_ipadapter_weight(self):
        with self.assertRaises(ValueError):
            self._graph(ipadapter_weight=0.0)
        with self.assertRaises(ValueError):
            self._graph(ipadapter_weight=6.0)

    def test_rejects_non_positive_steps(self):
        with self.assertRaises(ValueError):
            self._graph(steps=0)

    def test_prompts_mention_every_protected_construction_detail(self):
        for detail in ["collar", "button", "pintuck", "sleeve", "cuff", "periwinkle"]:
            self.assertIn(detail, lib.POSITIVE_PROMPT.lower())


class ParseSwapMibTests(unittest.TestCase):
    def test_parses_realistic_sysctl_output(self):
        text = "vm.swapusage: total = 2048.00M  used = 512.25M  free = 1535.75M  (encrypted)"
        self.assertEqual(lib.parse_swap_mib(text), 512.25)

    def test_parses_zero_used(self):
        text = "vm.swapusage: total = 0.00M  used = 0.00M  free = 0.00M"
        self.assertEqual(lib.parse_swap_mib(text), 0.0)

    def test_returns_none_on_unrecognized_format(self):
        self.assertIsNone(lib.parse_swap_mib("unexpected output from a future macOS version"))

    def test_returns_none_on_empty_string(self):
        self.assertIsNone(lib.parse_swap_mib(""))


class VerifyReferenceMatchesTests(unittest.TestCase):
    def test_identical_files_match(self):
        with tempfile.TemporaryDirectory() as tmp:
            a = pathlib.Path(tmp) / "a.png"
            b = pathlib.Path(tmp) / "b.png"
            a.write_bytes(b"same-bytes")
            b.write_bytes(b"same-bytes")
            self.assertTrue(lib.verify_reference_matches(a, b))

    def test_differing_files_do_not_match(self):
        with tempfile.TemporaryDirectory() as tmp:
            a = pathlib.Path(tmp) / "a.png"
            b = pathlib.Path(tmp) / "b.png"
            a.write_bytes(b"one")
            b.write_bytes(b"other")
            self.assertFalse(lib.verify_reference_matches(a, b))

    def test_missing_source_file_does_not_match(self):
        with tempfile.TemporaryDirectory() as tmp:
            a = pathlib.Path(tmp) / "missing.png"
            b = pathlib.Path(tmp) / "b.png"
            b.write_bytes(b"present")
            self.assertFalse(lib.verify_reference_matches(a, b))

    def test_missing_installed_file_does_not_match(self):
        with tempfile.TemporaryDirectory() as tmp:
            a = pathlib.Path(tmp) / "a.png"
            b = pathlib.Path(tmp) / "missing.png"
            a.write_bytes(b"present")
            self.assertFalse(lib.verify_reference_matches(a, b))


if __name__ == "__main__":
    unittest.main()
