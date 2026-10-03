from django.core.management.base import BaseCommand
from django.utils.text import slugify

from shop.models import Product


PRODUCTS = [
    {
        "name": "Sunday Ceramic Pitcher",
        "category": "Tableware",
        "description": "A softly sculpted stoneware pitcher for flowers, water, or a slow Sunday breakfast. Finished by hand in a warm chalk glaze.",
        "price": "42.00",
        "image_url": "https://images.unsplash.com/photo-1578749556568-bc2c40e68b61?auto=format&fit=crop&w=900&q=85",
        "stock": 18,
        "featured": True,
    },
    {
        "name": "Gather Woven Throw",
        "category": "Textiles",
        "description": "A generous cotton throw with an easy, tactile weave. Made for the end of the bed, the back of the sofa, and every in-between moment.",
        "price": "68.00",
        "image_url": "https://images.unsplash.com/photo-1600210492486-724fe5c67fb0?auto=format&fit=crop&w=900&q=85",
        "stock": 12,
        "featured": True,
    },
    {
        "name": "Arc Desk Lamp",
        "category": "Lighting",
        "description": "An uncomplicated reading light with a brushed finish and a thoughtful, adjustable silhouette. A steady companion for late pages and early starts.",
        "price": "96.00",
        "image_url": "https://images.unsplash.com/photo-1507473885765-e6ed057f782c?auto=format&fit=crop&w=900&q=85",
        "stock": 9,
        "featured": True,
    },
    {
        "name": "Field Notes Planter",
        "category": "Objects",
        "description": "A weighty little planter with a natural matte finish. Its clean shape gives leafy things room to be the main event.",
        "price": "34.00",
        "image_url": "https://images.unsplash.com/photo-1485955900006-10f4d324d411?auto=format&fit=crop&w=900&q=85",
        "stock": 24,
        "featured": False,
    },
    {
        "name": "Everyday Linen Napkins",
        "category": "Textiles",
        "description": "A set of four washed linen napkins, softened from the first use. Each one carries the small variations that make natural linen feel personal.",
        "price": "28.00",
        "image_url": "https://images.unsplash.com/photo-1603199506016-b9a594b593c0?auto=format&fit=crop&w=900&q=85",
        "stock": 31,
        "featured": False,
    },
    {
        "name": "Slow Morning Mug",
        "category": "Tableware",
        "description": "A hand-finished mug with a comfortable handle and a shape that settles nicely in your hands. Holds 12 ounces of something good.",
        "price": "22.00",
        "image_url": "https://images.unsplash.com/photo-1514228742587-6b1558fcca3d?auto=format&fit=crop&w=900&q=85",
        "stock": 27,
        "featured": False,
    },
    {
        "name": "Still Life Candle",
        "category": "Objects",
        "description": "A clean-burning soy candle with notes of cedar, bergamot, and a hint of green. Poured into a reusable glass vessel.",
        "price": "26.00",
        "image_url": "https://images.unsplash.com/photo-1603006905003-be475563bc59?auto=format&fit=crop&w=900&q=85",
        "stock": 22,
        "featured": False,
    },
    {
        "name": "Sunday Market Tote",
        "category": "Carry",
        "description": "A sturdy everyday carryall in heavyweight recycled cotton. Room for market finds, library books, and all the useful extras.",
        "price": "32.00",
        "image_url": "https://images.unsplash.com/photo-1590874103328-eac38a683ce7?auto=format&fit=crop&w=900&q=85",
        "stock": 15,
        "featured": False,
    },
]


class Command(BaseCommand):
    help = "Add the FORM sample collection to the database."

    def handle(self, *args, **options):
        created = 0
        for item in PRODUCTS:
            _, was_created = Product.objects.get_or_create(
                slug=slugify(item["name"]),
                defaults=item,
            )
            created += int(was_created)
        self.stdout.write(self.style.SUCCESS(f"Sample collection ready ({created} new products)."))