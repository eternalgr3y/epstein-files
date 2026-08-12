import unittest

from qa_request_budget import RequestBudget, RequestBudgetExceeded


class RequestBudgetTests(unittest.TestCase):
    def test_budget_stops_before_the_first_over_limit_request(self):
        budget = RequestBudget(2)
        budget.consume("home page")
        budget.consume("document page")

        with self.assertRaisesRegex(RequestBudgetExceeded, "used 2 of 2"):
            budget.consume("unexpected crawl")

        self.assertEqual(budget.used, 2)
        self.assertEqual(budget.remaining, 0)

    def test_preflight_rejects_a_crawl_that_cannot_fit(self):
        budget = RequestBudget(5, used=1)

        with self.assertRaisesRegex(RequestBudgetExceeded, "needs at least 5 more"):
            budget.ensure_available(5, "canonical page crawl")

        self.assertEqual(budget.used, 1)

    def test_zero_budget_is_a_valid_no_network_guard(self):
        budget = RequestBudget(0)

        with self.assertRaises(RequestBudgetExceeded):
            budget.consume("network request")


if __name__ == "__main__":
    unittest.main()
