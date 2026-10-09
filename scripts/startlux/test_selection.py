import unittest
from selection import choose_model, retain_current


class AdmissionTest(unittest.TestCase):
    def test_installed_ladder_and_pressure(self):
        installed = ["0.8b", "2b", "4b", "9b"]
        for memory, load, expected in [(20,.1,"4b"), (20,1,"2b"), (10,.1,"2b"), (6,.1,"0.8b")]:
            self.assertEqual(choose_model("auto", installed, memory, load), expected)
        self.assertEqual(choose_model("auto", ["0.8b", "4b"], 10, .1), "0.8b")
        with self.assertRaisesRegex(RuntimeError, "内存不足"):
            choose_model("auto", installed, 3.9, .1)
        with self.assertRaisesRegex(RuntimeError, "已安装"):
            choose_model("auto", ["9b"], 40, .1)

    def test_fixed_mode_does_not_silently_downgrade(self):
        with self.assertRaisesRegex(RuntimeError, "内存不足"):
            choose_model("2b", ["0.8b", "2b"], 6, .1)
        self.assertEqual(choose_model("9b", ["9b"], 30, 1), "9b")

    def test_only_upgrades_wait(self):
        self.assertFalse(retain_current("auto", "4b", "2b", 1, 10))
        self.assertFalse(retain_current("auto", "2b", "0.8b", 1, 6))
        self.assertTrue(retain_current("auto", "0.8b", "2b", 1, 10))
        self.assertFalse(retain_current("auto", "0.8b", "2b", 301, 10))


if __name__ == "__main__":
    unittest.main()
