from unittest.mock import patch

from frappe.tests.utils import FrappeTestCase

from pospire.pospire.api import m_pesa


class TestMpesaCallbacks(FrappeTestCase):
	@patch("pospire.pospire.api.m_pesa.frappe.new_doc")
	@patch("pospire.pospire.api.m_pesa._is_registered_shortcode", return_value=False)
	def test_confirmation_rejects_unregistered_shortcode(self, _is_registered, new_doc):
		result = m_pesa.confirmation(BusinessShortCode="unregistered")

		self.assertEqual(result, {"ResultCode": 1, "ResultDesc": "Rejected"})
		new_doc.assert_not_called()

	@patch("pospire.pospire.api.m_pesa._is_registered_shortcode", return_value=False)
	def test_validation_rejects_unregistered_shortcode(self, _is_registered):
		result = m_pesa.validation(BusinessShortCode="unregistered")

		self.assertEqual(result, {"ResultCode": 1, "ResultDesc": "Rejected"})

	@patch("pospire.pospire.api.m_pesa._is_registered_shortcode", return_value=True)
	def test_validation_accepts_registered_shortcode(self, _is_registered):
		result = m_pesa.validation(BusinessShortCode="registered")

		self.assertEqual(result, {"ResultCode": 0, "ResultDesc": "Accepted"})
