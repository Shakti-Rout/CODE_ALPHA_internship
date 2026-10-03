from django.contrib.auth import get_user_model
from django.test import TestCase
from django.urls import reverse

from .models import Order, Product


class StoreFlowTests(TestCase):
    def setUp(self):
        self.product = Product.objects.create(
            name="Everyday Vessel",
            slug="everyday-vessel",
            category="Objects",
            description="A useful ceramic vessel.",
            price="24.00",
            stock=4,
        )

    def test_product_listing_and_detail(self):
        listing = self.client.get(reverse("home"))
        detail = self.client.get(self.product.get_absolute_url())
        self.assertContains(listing, "Everyday Vessel")
        self.assertContains(detail, "A useful ceramic vessel.")

    def test_cart_add_and_quantity_update(self):
        self.client.post(reverse("add_to_cart", args=[self.product.pk]), {"next": reverse("cart")})
        self.assertContains(self.client.get(reverse("cart")), "Everyday Vessel")
        self.client.post(reverse("update_cart", args=[self.product.pk]), {"quantity": 3})
        self.assertEqual(self.client.session["cart"][str(self.product.pk)], 3)

    def test_checkout_requires_login(self):
        self.client.post(reverse("add_to_cart", args=[self.product.pk]), {"next": reverse("cart")})
        response = self.client.get(reverse("checkout"))
        self.assertRedirects(response, f"{reverse('login')}?next={reverse('checkout')}")

    def test_checkout_creates_order_and_decrements_stock(self):
        user = get_user_model().objects.create_user(username="shopper", password="GoodPassword123!")
        self.client.force_login(user)
        self.client.post(reverse("add_to_cart", args=[self.product.pk]), {"next": reverse("cart")})
        response = self.client.post(reverse("checkout"), {
            "full_name": "Alex Shopper",
            "email": "alex@example.com",
            "address": "12 Market Street",
            "city": "Springfield",
            "postal_code": "12345",
        })
        order = Order.objects.get(user=user)
        self.product.refresh_from_db()
        self.assertRedirects(response, reverse("order_confirmation", args=[order.pk]))
        self.assertEqual(order.total, self.product.price)
        self.assertEqual(order.items.get().quantity, 1)
        self.assertEqual(self.product.stock, 3)
        self.assertEqual(self.client.session["cart"], {})

    def test_register_creates_and_signs_in_user(self):
        response = self.client.post(reverse("register"), {
            "username": "newshopper",
            "password1": "GoodPassword123!",
            "password2": "GoodPassword123!",
        })
        self.assertRedirects(response, reverse("home"))
        self.assertTrue(self.client.session.get("_auth_user_id"))