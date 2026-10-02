package config

import "testing"

func TestModelPriceCostAndLookup(t *testing.T) {
	c := Config{ModelPrices: map[string]ModelPrice{
		"muse-spark-1.3": {InputPerMillion: 1.0, OutputPerMillion: 4.0},
		"wire-id":        {InputPerMillion: 2.0},
	}}

	price, ok := c.Price("muse-spark-1.3", "")
	if !ok {
		t.Fatal("a listed model must have a price")
	}
	if cost := price.Cost(1_000_000, 1_000_000); cost != 5.0 {
		t.Errorf("cost = %v, want 5", cost)
	}
	if _, ok := c.Price("unlisted", ""); ok {
		t.Error("an unlisted model must not have a price")
	}
	if _, ok := c.Price("catalogue-id", "wire-id"); !ok {
		t.Error("a price should be found by wire id")
	}
}
