import json
import unittest

from pipeline.llm_client import LlmUnavailableError, _first_message_content


class LlmResponseTest(unittest.TestCase):
    def test_reads_normal_message_content(self):
        raw = json.dumps({
            "choices": [{"message": {"content": '{"claims": []}'}, "finish_reason": "stop"}]
        })
        self.assertEqual(_first_message_content(raw), '{"claims": []}')

    def test_reports_output_limit_before_returning_partial_json(self):
        raw = json.dumps({
            "choices": [{
                "message": {"content": '{"claims": [{"item_key": "revenue"'},
                "finish_reason": "length",
            }]
        })
        with self.assertRaisesRegex(LlmUnavailableError, "max_tokens was exhausted"):
            _first_message_content(raw)

    def test_empty_final_content_remains_an_explicit_error(self):
        raw = json.dumps({
            "choices": [{
                "message": {"content": "", "reasoning_content": "internal reasoning"},
                "finish_reason": "stop",
            }]
        })
        with self.assertRaisesRegex(LlmUnavailableError, "no message content"):
            _first_message_content(raw)


if __name__ == "__main__":
    unittest.main()
