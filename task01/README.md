# FORM Store

A Django e-commerce starter with a responsive product catalog, product detail pages, a session shopping bag, user accounts, and database-backed order processing. SQLite stores products, users, orders, and order items.

## Run locally

Python 3.12+ and Django 6.1 are required. From this folder:

```powershell
python -m pip install -r requirements.txt
python manage.py migrate
python manage.py seed_products
python manage.py runserver
```

Open http://127.0.0.1:8000. Create a customer account from **Sign in**. The Django admin is available at `/admin/`; create an administrator with `python manage.py createsuperuser`.

## Verify

```powershell
python manage.py check
python manage.py test shop
```

The included secret key and `DEBUG = True` are for local development only. Set a private `SECRET_KEY`, disable debug mode, and configure allowed hosts before deploying.