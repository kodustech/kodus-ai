from django.http import JsonResponse

ITEMS = {
    1: {"id": 1, "name": "Mug", "price_cents": 1200, "stock": 3},
    2: {"id": 2, "name": "Lamp", "price_cents": 4500, "stock": 0},
}


def item_list(request):
    return JsonResponse({"items": list(ITEMS.values())})


def item_detail(request, pk):
    item = ITEMS.get(pk)
    if item is None:
        return JsonResponse({"error": "not found"}, status=404)
    return JsonResponse({"id": item["id"], "name": item["name"], "price_cents": item["price_cents"], "in_stock": item["stock"] > 0})
