from django.conf import settings
from django.db import models
from django.urls import reverse


class Product(models.Model):
    name = models.CharField(max_length=140)
    slug = models.SlugField(unique=True)
    category = models.CharField(max_length=60)
    description = models.TextField()
    price = models.DecimalField(max_digits=9, decimal_places=2)
    image_url = models.URLField(blank=True)
    stock = models.PositiveIntegerField(default=0)
    featured = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-featured", "name"]

    def __str__(self):
        return self.name

    def get_absolute_url(self):
        return reverse("product_detail", args=[self.slug])


class Order(models.Model):
    class Status(models.TextChoices):
        PLACED = "placed", "Placed"
        PROCESSING = "processing", "Processing"
        SHIPPED = "shipped", "Shipped"
        COMPLETE = "complete", "Complete"

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="orders")
    created_at = models.DateTimeField(auto_now_add=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.PLACED)
    full_name = models.CharField(max_length=140)
    email = models.EmailField()
    address = models.CharField(max_length=240)
    city = models.CharField(max_length=100)
    postal_code = models.CharField(max_length=24)
    total = models.DecimalField(max_digits=10, decimal_places=2)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return f"Order #{self.pk} - {self.user}"


class OrderItem(models.Model):
    order = models.ForeignKey(Order, on_delete=models.CASCADE, related_name="items")
    product = models.ForeignKey(Product, on_delete=models.PROTECT, related_name="order_items")
    product_name = models.CharField(max_length=140)
    unit_price = models.DecimalField(max_digits=9, decimal_places=2)
    quantity = models.PositiveIntegerField()

    def __str__(self):
        return f"{self.quantity} x {self.product_name}"

    @property
    def line_total(self):
        return self.unit_price * self.quantity