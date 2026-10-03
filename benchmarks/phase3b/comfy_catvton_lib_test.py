"""Unit tests for comfy_catvton_lib.py - pure graph-building logic only,
no ComfyUI, no model loading. Run with:
    python3 -m unittest benchmarks/phase3b/comfy_catvton_lib_test.py -v
"""
import unittest

import comfy_catvton_lib as lib


class BuildGraphTests(unittest.TestCase):
    def _graph(self, **overrides):
        kwargs = dict(
            person_image_filename="person.png",
            garment_image_filename="garment.png",
            mask_image_filename="mask.png",
            seed=42,
            filename_prefix="phase3b-catvton-test",
        )
        kwargs.update(overrides)
        return lib.build_graph(**kwargs)

    def test_returns_exactly_six_nodes(self):
        self.assertEqual(len(self._graph()), 6)

    def test_three_load_image_nodes_reference_the_right_filenames(self):
        graph = self._graph()
        self.assertEqual(graph["1"]["inputs"]["image"], "person.png")
        self.assertEqual(graph["2"]["inputs"]["image"], "garment.png")
        self.assertEqual(graph["3"]["inputs"]["image"], "mask.png")

    def test_pipeline_feeds_catvton_node(self):
        graph = self._graph()
        self.assertEqual(graph["5"]["inputs"]["pipe"], ["4", 0])

    def test_catvton_inputs_wired_to_the_three_load_image_nodes(self):
        graph = self._graph()
        self.assertEqual(graph["5"]["inputs"]["target_image"], ["1", 0])
        self.assertEqual(graph["5"]["inputs"]["refer_image"], ["2", 0])
        self.assertEqual(graph["5"]["inputs"]["mask_image"], ["3", 0])

    def test_save_image_is_the_terminal_node_consuming_catvton_output(self):
        graph = self._graph()
        self.assertEqual(graph["6"]["inputs"]["images"], ["5", 0])
        self.assertEqual(graph["6"]["inputs"]["filename_prefix"], "phase3b-catvton-test")

    def test_default_device_is_mps_not_cuda(self):
        graph = self._graph()
        self.assertEqual(graph["4"]["inputs"]["device"], "mps")

    def test_default_precision_is_fp16(self):
        # Changed from fp32 after the first trial crashed (36 GiB attention
        # buffer) - fp16 is one of the two independently-justified levers
        # in the diagnosed fix.
        graph = self._graph()
        self.assertEqual(graph["4"]["inputs"]["mixed_precision"], "fp16")

    def test_default_resolution_is_the_c3_profile_not_c2_or_the_crashing_default(self):
        # C2 (256x384) was rejected for fidelity; the crashing upstream
        # default is 768x1024. C3's recovered resolution is 512x768.
        graph = self._graph()
        self.assertEqual(graph["5"]["inputs"]["width"], 512)
        self.assertEqual(graph["5"]["inputs"]["height"], 768)
        self.assertNotEqual((graph["5"]["inputs"]["width"], graph["5"]["inputs"]["height"]), (768, 1024))
        self.assertNotEqual((graph["5"]["inputs"]["width"], graph["5"]["inputs"]["height"]), (256, 384))

    def test_default_attn_chunk_size_is_enabled(self):
        graph = self._graph()
        self.assertEqual(graph["4"]["inputs"]["attn_chunk_size"], 512)

    def test_width_and_height_are_threaded_through_to_the_catvton_node(self):
        graph = self._graph(width=320, height=448)
        self.assertEqual(graph["5"]["inputs"]["width"], 320)
        self.assertEqual(graph["5"]["inputs"]["height"], 448)

    def test_attn_chunk_size_is_threaded_through_to_the_pipeline_loader(self):
        graph = self._graph(attn_chunk_size=256)
        self.assertEqual(graph["4"]["inputs"]["attn_chunk_size"], 256)

    def test_attn_chunk_size_none_disables_chunking_via_zero(self):
        # The node's own convention (see LoadCatVTONPipeline.INPUT_TYPES):
        # 0 means "chunking disabled", not a literal zero-size chunk.
        graph = self._graph(attn_chunk_size=None)
        self.assertEqual(graph["4"]["inputs"]["attn_chunk_size"], 0)

    def test_rejects_negative_attn_chunk_size(self):
        with self.assertRaises(ValueError):
            self._graph(attn_chunk_size=-1)

    def test_rejects_width_not_a_multiple_of_64(self):
        with self.assertRaises(ValueError):
            self._graph(width=300)

    def test_rejects_height_not_a_multiple_of_64(self):
        with self.assertRaises(ValueError):
            self._graph(height=300)

    def test_rejects_non_positive_width_or_height(self):
        with self.assertRaises(ValueError):
            self._graph(width=0)
        with self.assertRaises(ValueError):
            self._graph(height=0)

    def test_seed_threaded_through(self):
        graph = self._graph(seed=987654)
        self.assertEqual(graph["5"]["inputs"]["seed"], 987654)

    def test_rejects_non_positive_steps(self):
        with self.assertRaises(ValueError):
            self._graph(steps=0)

    def test_rejects_unknown_precision(self):
        with self.assertRaises(ValueError):
            self._graph(mixed_precision="int8")

    def test_rejects_unknown_device(self):
        with self.assertRaises(ValueError):
            self._graph(device="tpu")

    def test_upstream_default_steps_and_cfg_preserved(self):
        # These match the upstream node's own INPUT_TYPES defaults
        # (Comfyui-CatVTON/__init__.py CatVTON.INPUT_TYPES) - not values
        # invented in this repo.
        graph = self._graph()
        self.assertEqual(graph["5"]["inputs"]["steps"], 50)
        self.assertEqual(graph["5"]["inputs"]["cfg"], 2.5)


if __name__ == "__main__":
    unittest.main()
