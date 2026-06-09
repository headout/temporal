package store

import (
	"context"
	"fmt"

	"go.temporal.io/server/api/visibilityservice/v1"
	"go.temporal.io/server/common/log"
	"go.temporal.io/server/common/log/tag"
	"go.temporal.io/server/common/persistence/visibility/manager"
)

type VisibilityCache interface {
	Get(ctx context.Context, key string) (*InternalGetWorkflowExecutionResponse, bool)
	Put(ctx context.Context, key string, value *InternalGetWorkflowExecutionResponse) error
	GetCount(ctx context.Context, key string) (*InternalCountExecutionsResponse, bool)
	PutCount(ctx context.Context, key string, value *InternalCountExecutionsResponse) error
	GetList(ctx context.Context, key string) (*InternalListExecutionsResponse, bool)
	PutList(ctx context.Context, key string, value *InternalListExecutionsResponse) error
	Delete(ctx context.Context, key string) error
	Close() error
}

type cachedVisibilityStore struct {
	store  VisibilityStore
	cache  VisibilityCache
	logger log.Logger
}

func NewCachedVisibilityStore(
	store VisibilityStore,
	cache VisibilityCache,
	logger log.Logger,
) VisibilityStore {
	return &cachedVisibilityStore{
		store:  store,
		cache:  cache,
		logger: logger,
	}
}

func (c *cachedVisibilityStore) Close() {
	if c.cache != nil {
		if err := c.cache.Close(); err != nil {
			c.logger.Error("Failed to close visibility cache", tag.Error(err))
		}
	}
	c.store.Close()
}

func (c *cachedVisibilityStore) GetName() string {
	return c.store.GetName()
}

func (c *cachedVisibilityStore) GetIndexName() string {
	return c.store.GetIndexName()
}

func (c *cachedVisibilityStore) ValidateCustomSearchAttributes(searchAttributes map[string]any) (map[string]any, error) {
	return c.store.ValidateCustomSearchAttributes(searchAttributes)
}

func (c *cachedVisibilityStore) RecordWorkflowExecutionStarted(
	ctx context.Context,
	request *InternalRecordWorkflowExecutionStartedRequest,
) error {
	err := c.store.RecordWorkflowExecutionStarted(ctx, request)
	if err == nil {
		cacheKey := c.buildCacheKey(request.NamespaceID, request.RunID)
		if err := c.cache.Delete(ctx, cacheKey); err != nil {
			c.logger.Warn("Failed to invalidate cache on workflow start", tag.Error(err))
		}
	}
	return err
}

func (c *cachedVisibilityStore) RecordWorkflowExecutionClosed(
	ctx context.Context,
	request *InternalRecordWorkflowExecutionClosedRequest,
) error {
	err := c.store.RecordWorkflowExecutionClosed(ctx, request)
	if err == nil {
		cacheKey := c.buildCacheKey(request.NamespaceID, request.RunID)
		if err := c.cache.Delete(ctx, cacheKey); err != nil {
			c.logger.Warn("Failed to invalidate cache on workflow close", tag.Error(err))
		}
	}
	return err
}

func (c *cachedVisibilityStore) UpsertWorkflowExecution(
	ctx context.Context,
	request *InternalUpsertWorkflowExecutionRequest,
) error {
	err := c.store.UpsertWorkflowExecution(ctx, request)
	if err == nil {
		cacheKey := c.buildCacheKey(request.NamespaceID, request.RunID)
		if err := c.cache.Delete(ctx, cacheKey); err != nil {
			c.logger.Warn("Failed to invalidate cache on workflow upsert", tag.Error(err))
		}
	}
	return err
}

func (c *cachedVisibilityStore) DeleteWorkflowExecution(
	ctx context.Context,
	request *manager.VisibilityDeleteWorkflowExecutionRequest,
) error {
	err := c.store.DeleteWorkflowExecution(ctx, request)
	if err == nil {
		cacheKey := c.buildCacheKey(request.NamespaceID.String(), request.RunID)
		if err := c.cache.Delete(ctx, cacheKey); err != nil {
			c.logger.Warn("Failed to invalidate cache on workflow delete", tag.Error(err))
		}
	}
	return err
}

func (c *cachedVisibilityStore) ListWorkflowExecutions(
	ctx context.Context,
	request *manager.ListWorkflowExecutionsRequestV2,
) (*InternalListExecutionsResponse, error) {
	cacheKey := c.buildListCacheKey(request.NamespaceID.String(), request.Query, request.PageSize, request.NextPageToken)

	if cachedResp, found := c.cache.GetList(ctx, cacheKey); found {
		return cachedResp, nil
	}

	resp, err := c.store.ListWorkflowExecutions(ctx, request)
	if err != nil {
		return nil, err
	}

	if err := c.cache.PutList(ctx, cacheKey, resp); err != nil {
		c.logger.Warn("Failed to cache list result", tag.Error(err))
	}

	return resp, nil
}

func (c *cachedVisibilityStore) CountWorkflowExecutions(
	ctx context.Context,
	request *manager.CountWorkflowExecutionsRequest,
) (*InternalCountExecutionsResponse, error) {
	cacheKey := c.buildCountCacheKey(request.NamespaceID.String(), request.Query)

	if cachedResp, found := c.cache.GetCount(ctx, cacheKey); found {
		return cachedResp, nil
	}

	resp, err := c.store.CountWorkflowExecutions(ctx, request)
	if err != nil {
		return nil, err
	}

	if err := c.cache.PutCount(ctx, cacheKey, resp); err != nil {
		c.logger.Warn("Failed to cache count result", tag.Error(err))
	}

	return resp, nil
}

func (c *cachedVisibilityStore) GetWorkflowExecution(
	ctx context.Context,
	request *manager.GetWorkflowExecutionRequest,
) (*InternalGetWorkflowExecutionResponse, error) {
	cacheKey := c.buildCacheKey(request.NamespaceID.String(), request.RunID)

	if cachedResp, found := c.cache.Get(ctx, cacheKey); found {
		return cachedResp, nil
	}

	resp, err := c.store.GetWorkflowExecution(ctx, request)
	if err != nil {
		return nil, err
	}

	if err := c.cache.Put(ctx, cacheKey, resp); err != nil {
		c.logger.Warn("Failed to cache workflow execution", tag.Error(err))
	}

	return resp, nil
}

func (c *cachedVisibilityStore) ListChasmExecutions(
	ctx context.Context,
	request *visibilityservice.ListChasmExecutionsRequest,
) (*InternalListExecutionsResponse, error) {
	return c.store.ListChasmExecutions(ctx, request)
}

func (c *cachedVisibilityStore) CountChasmExecutions(
	ctx context.Context,
	request *visibilityservice.CountChasmExecutionsRequest,
) (*InternalCountExecutionsResponse, error) {
	cacheKey := c.buildCountCacheKey(request.NamespaceId, request.Query)

	if cachedResp, found := c.cache.GetCount(ctx, cacheKey); found {
		return cachedResp, nil
	}

	resp, err := c.store.CountChasmExecutions(ctx, request)
	if err != nil {
		return nil, err
	}

	if err := c.cache.PutCount(ctx, cacheKey, resp); err != nil {
		c.logger.Warn("Failed to cache chasm count result", tag.Error(err))
	}

	return resp, nil
}

func (c *cachedVisibilityStore) AddSearchAttributes(
	ctx context.Context,
	request *manager.AddSearchAttributesRequest,
) error {
	return c.store.AddSearchAttributes(ctx, request)
}

func (c *cachedVisibilityStore) buildCacheKey(namespaceID string, runID string) string {
	return fmt.Sprintf("vis:%s:%s", namespaceID, runID)
}

func (c *cachedVisibilityStore) buildCountCacheKey(namespaceID string, query string) string {
	return fmt.Sprintf("vis:count:%s:%s", namespaceID, query)
}

func (c *cachedVisibilityStore) buildListCacheKey(namespaceID string, query string, pageSize int, nextPageToken []byte) string {
	return fmt.Sprintf("vis:list:%s:%s:%d:%x", namespaceID, query, pageSize, nextPageToken)
}
