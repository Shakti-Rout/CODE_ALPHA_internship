from django.urls import path

from . import views

urlpatterns = [
    path("", views.home, name="home"),
    path("products/<slug:slug>/", views.product_detail, name="product_detail"),
    path("cart/", views.cart_view, name="cart"),
    path("cart/add/<int:product_id>/", views.add_to_cart, name="add_to_cart"),
    path("cart/update/<int:product_id>/", views.update_cart, name="update_cart"),
    path("checkout/", views.checkout, name="checkout"),
    path("orders/<int:order_id>/", views.order_confirmation, name="order_confirmation"),
    path("account/register/", views.register, name="register"),
    path("account/orders/", views.order_history, name="order_history"),
]