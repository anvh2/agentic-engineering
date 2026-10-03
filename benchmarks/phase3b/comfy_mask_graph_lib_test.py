"""Unit tests for comfy_mask_graph_lib.py - pure graph-building logic, no
ComfyUI, no network, no ML models. Run with:
    python3 -m unittest benchmarks/phase3b/comfy_mask_graph_lib_test.py -v
"""
import unittest

import comfy_mask_graph_lib as lib


class BuildGraphTests(unittest.TestCase):
    def _graph(self, **overrides):
        kwargs = dict(
            person_image_filename="person.png",
            detection_prompt="shirt, t-shirt, blouse, top",
            filename_prefix="phase3b-mask-test",
        )
        kwargs.update(overrides)
        return lib.build_graph(**kwargs)

    def test_returns_six_nodes(self):
        self.assertEqual(len(self._graph()), 6)

    def test_load_image_uses_given_filename(self):
        self.assertEqual(self._graph()["1"]["inputs"]["image"], "person.png")

    def test_segment_node_consumes_both_loaders_and_the_image(self):
        graph = self._graph()
        seg = graph["4"]["inputs"]
        self.assertEqual(seg["sam_model"], ["3", 0])
        self.assertEqual(seg["grounding_dino_model"], ["2", 0])
        self.assertEqual(seg["image"], ["1", 0])

    def test_segment_node_carries_the_detection_prompt(self):
        graph = self._graph(detection_prompt="shirt, blouse")
        self.assertEqual(graph["4"]["inputs"]["prompt"], "shirt, blouse")

    def test_mask_to_image_consumes_the_mask_output_not_the_image_output(self):
        graph = self._graph()
        # GroundingDinoSAM2Segment outputs (IMAGE, MASK) at slots (0, 1) -
        # MaskToImage must read slot 1, not slot 0.
        self.assertEqual(graph["5"]["inputs"]["mask"], ["4", 1])

    def test_save_image_is_terminal_and_uses_filename_prefix(self):
        graph = self._graph(filename_prefix="custom-prefix")
        self.assertEqual(graph["6"]["inputs"]["images"], ["5", 0])
        self.assertEqual(graph["6"]["inputs"]["filename_prefix"], "custom-prefix")

    def test_no_ml_class_types_leak_in_as_python_objects(self):
        # The graph is plain JSON-able data - class_type values are strings
        # naming nodes that execute inside ComfyUI, nothing here imports or
        # instantiates GroundingDINO/SAM2/torch.
        graph = self._graph()
        for n in graph.values():
            self.assertIsInstance(n["class_type"], str)

    def test_rejects_out_of_range_threshold(self):
        with self.assertRaises(ValueError):
            self._graph(threshold=1.5)
        with self.assertRaises(ValueError):
            self._graph(threshold=-0.1)

    def test_rejects_empty_detection_prompt(self):
        with self.assertRaises(ValueError):
            self._graph(detection_prompt="   ")

    def test_default_models_match_what_is_actually_installed(self):
        graph = self._graph()
        self.assertEqual(graph["2"]["inputs"]["model_name"], "GroundingDINO_SwinT_OGC (694MB)")
        self.assertEqual(graph["3"]["inputs"]["model_name"], "sam2_hiera_tiny")


if __name__ == "__main__":
    unittest.main()
