package cache

import (
	"context"

	"go.temporal.io/server/common/persistence/visibility/store"
)

type noOpCache struct{}

func NewNoOpCache() store.VisibilityCache {
	return &noOpCache{}
}

func (c *noOpCache) Get(ctx context.Context, key string) (*store.InternalGetWorkflowExecutionResponse, bool) {
	return nil, false
}

func (c *noOpCache) Put(ctx context.Context, key string, value *store.InternalGetWorkflowExecutionResponse) error {
	return nil
}

func (c *noOpCache) GetCount(ctx context.Context, key string) (*store.InternalCountExecutionsResponse, bool) {
	return nil, false
}

func (c *noOpCache) PutCount(ctx context.Context, key string, value *store.InternalCountExecutionsResponse) error {
	return nil
}

func (c *noOpCache) GetList(ctx context.Context, key string) (*store.InternalListExecutionsResponse, bool) {
	return nil, false
}

func (c *noOpCache) PutList(ctx context.Context, key string, value *store.InternalListExecutionsResponse) error {
	return nil
}

func (c *noOpCache) Delete(ctx context.Context, key string) error {
	return nil
}

func (c *noOpCache) Close() error {
	return nil
}
