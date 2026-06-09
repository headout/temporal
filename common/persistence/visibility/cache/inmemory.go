package cache

import (
	"context"
	"time"

	"go.temporal.io/server/common/cache"
	"go.temporal.io/server/common/clock"
	"go.temporal.io/server/common/persistence/visibility/store"
)

type inMemoryCache struct {
	cache cache.Cache
	ttl   time.Duration
}

func NewInMemoryVisibilityCache(maxSize int, ttl time.Duration) store.VisibilityCache {
	opts := &cache.Options{
		TTL:        ttl,
		Pin:        false,
		TimeSource: clock.NewRealTimeSource(),
	}

	return &inMemoryCache{
		cache: cache.New(maxSize, opts),
		ttl:   ttl,
	}
}

func (c *inMemoryCache) Get(ctx context.Context, key string) (*store.InternalGetWorkflowExecutionResponse, bool) {
	val := c.cache.Get(key)
	if val == nil {
		return nil, false
	}

	resp, ok := val.(*store.InternalGetWorkflowExecutionResponse)
	return resp, ok
}

func (c *inMemoryCache) Put(ctx context.Context, key string, value *store.InternalGetWorkflowExecutionResponse) error {
	c.cache.Put(key, value)
	return nil
}

func (c *inMemoryCache) GetCount(ctx context.Context, key string) (*store.InternalCountExecutionsResponse, bool) {
	val := c.cache.Get(key)
	if val == nil {
		return nil, false
	}

	resp, ok := val.(*store.InternalCountExecutionsResponse)
	return resp, ok
}

func (c *inMemoryCache) PutCount(ctx context.Context, key string, value *store.InternalCountExecutionsResponse) error {
	c.cache.Put(key, value)
	return nil
}

func (c *inMemoryCache) GetList(ctx context.Context, key string) (*store.InternalListExecutionsResponse, bool) {
	val := c.cache.Get(key)
	if val == nil {
		return nil, false
	}

	resp, ok := val.(*store.InternalListExecutionsResponse)
	return resp, ok
}

func (c *inMemoryCache) PutList(ctx context.Context, key string, value *store.InternalListExecutionsResponse) error {
	c.cache.Put(key, value)
	return nil
}

func (c *inMemoryCache) Delete(ctx context.Context, key string) error {
	c.cache.Delete(key)
	return nil
}

func (c *inMemoryCache) Close() error {
	return nil
}
