# Commonroom

A small social network built with HTML, CSS, vanilla JavaScript, Django, and SQLite. Members can create profiles, share text or image-link posts, reply to posts, like posts, and follow other members. The home feed includes a public "For you" view and a signed-in "Following" view.

## Run locally

Use Python 3.12+ and Django 6.1. From this folder:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python manage.py migrate
python manage.py runserver
```

Open http://127.0.0.1:8000 and create an account. The Django admin is at `/admin/`; create an administrator with `python manage.py createsuperuser`.

## Verify

```powershell
python manage.py check
python manage.py test network
```

The included secret key and `DEBUG = True` are for local development only. Use a private environment-provided secret key, disable debug mode, and set production hosts before deploying.
