from decimal import Decimal

from django.contrib import messages
from django.contrib.auth import login
from django.contrib.auth.decorators import login_required
from django.contrib.auth.forms import UserCreationForm
from django.db import transaction
from django.db.models import Q
from django.http import Http404
from django.shortcuts import get_object_or_404, redirect, render
from django.utils.http import url_has_allowed_host_and_scheme
from django.views.decorators.http import require_POST

from .models import Order, OrderItem, Product


def home(request):
    products = Product.objects.all()
    query = request.GET.get("q", "").strip()
    category = request.GET.get("category", "").strip()
    if query:
        products = products.filter(Q(name__icontains=query) | Q(description__icontains=query))
    if category:
        products = products.filter(category__iexact=category)
    return render(request, "index.html", {
        "products": products,
        "categories": Product.objects.order_by("category").values_list("category", flat=True).distinct(),
        "query": query,
        "selected_category": category,
    })


def product_detail(request, slug):
    product = get_object_or_404(Product, slug=slug)
    related_products = Product.objects.filter(category=product.category).exclude(pk=product.pk)[:3]
    return render(request, "shop/product_detail.html", {
        "product": product,
        "related_products": related_products,
    })


def _cart_lines(request):
    cart = request.session.get("cart", {})
    products = Product.objects.filter(pk__in=cart.keys())
    lines = []
    total = Decimal("0.00")
    for product in products:
        quantity = max(0, min(int(cart.get(str(product.pk), 0)), product.stock))
        if quantity:
            line_total = product.price * quantity
            lines.append({"product": product, "quantity": quantity, "line_total": line_total})
            total += line_total
    return lines, total


def cart_view(request):
    lines, total = _cart_lines(request)
    return render(request, "shop/cart.html", {"lines": lines, "total": total})


@require_POST
def add_to_cart(request, product_id):
    product = get_object_or_404(Product, pk=product_id)
    cart = request.session.get("cart", {})
    key = str(product.pk)
    current = int(cart.get(key, 0))
    if product.stock < 1:
        messages.error(request, "That item is currently out of stock.")
    else:
        cart[key] = min(current + 1, product.stock)
        request.session["cart"] = cart
        messages.success(request, f"{product.name} added to your bag.")
    destination = request.POST.get("next", "")
    if not url_has_allowed_host_and_scheme(destination, {request.get_host()}):
        destination = "cart"
    return redirect(destination)


@require_POST
def update_cart(request, product_id):
    cart = request.session.get("cart", {})
    key = str(product_id)
    if key in cart:
        try:
            quantity = int(request.POST.get("quantity", 0))
        except (TypeError, ValueError):
            quantity = 0
        product = Product.objects.filter(pk=product_id).first()
        if not product or quantity <= 0:
            cart.pop(key, None)
        else:
            cart[key] = min(quantity, product.stock)
        request.session["cart"] = cart
    return redirect("cart")


@login_required
def checkout(request):
    lines, total = _cart_lines(request)
    if not lines:
        messages.info(request, "Your bag is empty.")
        return redirect("home")

    if request.method == "POST":
        full_name = request.POST.get("full_name", "").strip()
        email = request.POST.get("email", "").strip()
        address = request.POST.get("address", "").strip()
        city = request.POST.get("city", "").strip()
        postal_code = request.POST.get("postal_code", "").strip()
        if not all((full_name, email, address, city, postal_code)):
            messages.error(request, "Complete each delivery field to place your order.")
        else:
            with transaction.atomic():
                product_ids = [line["product"].pk for line in lines]
                locked_products = {
                    product.pk: product
                    for product in Product.objects.select_for_update().filter(pk__in=product_ids)
                }
                current_lines = []
                stock_error = False
                for line in lines:
                    product = locked_products.get(line["product"].pk)
                    if product is None or product.stock < line["quantity"]:
                        stock_error = True
                        break
                    current_lines.append((product, line["quantity"]))
                if stock_error:
                    transaction.set_rollback(True)
                    messages.error(request, "Stock changed while you were checking out. Review your bag and try again.")
                else:
                    order_total = sum((product.price * quantity for product, quantity in current_lines), Decimal("0.00"))
                    order = Order.objects.create(
                        user=request.user,
                        full_name=full_name,
                        email=email,
                        address=address,
                        city=city,
                        postal_code=postal_code,
                        total=order_total,
                    )
                    for product, quantity in current_lines:
                        OrderItem.objects.create(
                            order=order,
                            product=product,
                            product_name=product.name,
                            unit_price=product.price,
                            quantity=quantity,
                        )
                        product.stock -= quantity
                        product.save(update_fields=["stock"])
                    request.session["cart"] = {}
                    return redirect("order_confirmation", order_id=order.pk)
        lines, total = _cart_lines(request)

    return render(request, "shop/checkout.html", {"lines": lines, "total": total})


@login_required
def order_confirmation(request, order_id):
    order = get_object_or_404(Order.objects.prefetch_related("items"), pk=order_id, user=request.user)
    return render(request, "shop/order_confirmation.html", {"order": order})


@login_required
def order_history(request):
    orders = request.user.orders.prefetch_related("items")
    return render(request, "shop/order_history.html", {"orders": orders})


def register(request):
    if request.user.is_authenticated:
        return redirect("home")
    form = UserCreationForm(request.POST or None)
    if request.method == "POST" and form.is_valid():
        user = form.save()
        login(request, user)
        return redirect("home")
    return render(request, "registration/register.html", {"form": form})